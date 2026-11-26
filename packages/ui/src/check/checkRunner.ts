import type { CollectionState, EventFactory, KnownEvent } from '@flash/core';
import { mediaHashesUsedByBackups } from '@flash/core/backup';
import {
  checkLogCoverage,
  checkMedia,
  compareCollectionStatesAsync,
  mediaFilesToDelete,
  planMediaRemoval,
  rebuildFromEventsAsync,
  type CollectionComparison,
  type MediaCheckReport,
} from '@flash/core/check';
import { deserializeCollectionState, serializeCollectionState } from '@flash/core/snapshot';
import { applyEvents, createEmptyState } from '@flash/core';
import type { MaterializedCardRow, PlatformServices } from '@flash/platform';
import { openBackupStore } from '../backups/backupRunner.ts';
import { storedMediaEntries } from '../state/storedMedia.ts';
import { announceRebuild } from '../state/rebuildChannel.ts';
import { COLLECTION_REBUILT_KV_KEY } from '../state/rebuildSignal.ts';
import { recentlyStoredMedia } from '../state/recentMedia.ts';

/**
 * Settings > Check media and Check database (`@flash/core/check`). Lazy chunk (§8): nothing here
 * is on the initial bundle.
 */

export interface CheckContext {
  platform: PlatformServices;
  getState: () => CollectionState;
}

export interface MediaCheckResult {
  report: MediaCheckReport;
  /** The storage can list its files; without it only files in the collection are checked. */
  canListFiles: boolean;
  /** The storage can delete files; without it removal only takes them out of the collection. */
  canDeleteFiles: boolean;
}

export async function runMediaCheck(ctx: CheckContext): Promise<MediaCheckResult> {
  const storage = ctx.platform.storage;
  const storedHashes = storage.listMediaHashes ? await storage.listMediaHashes() : null;
  const store = await openBackupStore(storage);
  const backupHashes = store ? mediaHashesUsedByBackups(await store.list()) : new Set<string>();
  const state = ctx.getState();
  // Without a file listing, every file the collection lists that this device has counts as stored.
  let stored: string[];
  if (storedHashes) {
    stored = storedHashes;
  } else {
    stored = [];
    for (const hash of state.media.keys()) {
      if (await storage.getMedia(hash)) stored.push(hash);
    }
  }
  return {
    report: checkMedia(state, { storedHashes: stored, backupHashes }),
    canListFiles: storedHashes !== null,
    canDeleteFiles: typeof storage.deleteMedia === 'function',
  };
}

export interface RemoveMediaContext extends CheckContext {
  emitEvents: (events: readonly KnownEvent[]) => void;
  getEventFactory: () => EventFactory;
}

export interface RemoveMediaResult {
  /** Files taken out of the collection (on every synced device). */
  removedFromCollection: number;
  /** Files deleted from this device's storage. */
  filesDeleted: number;
  /** Files a kept backup lists, so they stay on this device until it rolls off. */
  filesKeptForBackups: number;
}

/**
 * Removes the unused files of a fresh media check: `MediaRemoved` events first (so sync stops
 * fetching them), then the stored files no kept backup lists. Files still used by the time this
 * runs (an edit since the check) are left alone because the check is run again first.
 */
export async function removeUnusedMedia(ctx: RemoveMediaContext): Promise<RemoveMediaResult> {
  const checked = (await runMediaCheck(ctx)).report;
  const nowMs = Date.now();
  // An import stores its files before the events that use them (D16): leave recent ones alone.
  const recent = recentlyStoredMedia(nowMs);
  const report: MediaCheckReport = {
    ...checked,
    unused: checked.unused.filter((f) => !recent.has(f.hash)),
  };
  const factory = ctx.getEventFactory();
  const events = planMediaRemoval(report).map((step) =>
    factory.create(step.type, step.payload, nowMs),
  ) as KnownEvent[];
  if (events.length > 0) ctx.emitEvents(events);
  let filesDeleted = 0;
  const storage = ctx.platform.storage;
  if (storage.deleteMedia) {
    for (const hash of mediaFilesToDelete(report)) {
      await storage.deleteMedia(hash);
      filesDeleted += 1;
    }
  }
  return {
    removedFromCollection: events.length,
    filesDeleted,
    filesKeptForBackups: report.unused.filter((f) => f.stored && f.keepFileForBackups).length,
  };
}

/**
 * Adds the files of a fresh media check that notes use and this device stores, but the
 * collection no longer lists, back to the collection (so sync shares them again). Returns how
 * many were added.
 */
export async function reAddUnlistedMedia(ctx: RemoveMediaContext): Promise<number> {
  const { report } = await runMediaCheck(ctx);
  const entries = await storedMediaEntries(
    ctx.platform.storage,
    report.unlisted.map((f) => f.hash),
  );
  if (entries.length === 0) return 0;
  const factory = ctx.getEventFactory();
  const nowMs = Date.now();
  ctx.emitEvents(entries.map((media) => factory.create('MediaAdded', { media }, nowMs)));
  return entries.length;
}

export type DatabaseCheckMode =
  /** Rebuilt from the whole event log. */
  | 'full'
  /** The log lacks history another device folded into a snapshot: rebuilt from the saved snapshot. */
  | 'snapshot';

export interface DatabaseCheckResult {
  mode: DatabaseCheckMode;
  comparison: CollectionComparison;
  /** Events read from the log. */
  logEvents: number;
  /** The collection changed while the check ran, so differences may be from that. */
  changedDuringCheck: boolean;
  /** Present for a full rebuild: what `saveRebuiltCollection` writes. */
  rebuilt?: RebuiltCollection;
}

export interface RebuiltCollection {
  state: CollectionState;
  localSeq: number;
  watermarks: Record<string, number>;
}

/** Yields to the browser between the heavy steps of a database check (§8). */
function pauseForHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function rebuildOnce(
  ctx: CheckContext,
): Promise<Omit<DatabaseCheckResult, 'changedDuringCheck'>> {
  const storage = ctx.platform.storage;
  // One read gives the events and the local seq they reach, so the saved snapshot's `localSeq`
  // covers exactly the events it was rebuilt from (no event replayed twice or skipped at boot).
  const { events, maxLocalSeq: localSeq } = await storage.getEventsAfterLocalSeq(0);
  const current = ctx.getState();
  const coverage = checkLogCoverage(events, current.snapshotWatermarks);
  if (coverage.complete) {
    const state = await rebuildFromEventsAsync(events, pauseForHost);
    return {
      mode: 'full',
      logEvents: events.length,
      comparison: await compareCollectionStatesAsync(state, ctx.getState(), pauseForHost),
      rebuilt: { state, localSeq, watermarks: coverage.maxSeqByDevice },
    };
  }
  const saved = await storage.getLocalSnapshot();
  const state = saved ? deserializeCollectionState(saved.snapshot) : createEmptyState();
  const delta = saved ? await storage.getEventsAfterLocalSeq(saved.localSeq) : { events };
  applyEvents(state, delta.events);
  await pauseForHost();
  return {
    mode: 'snapshot',
    logEvents: events.length,
    comparison: await compareCollectionStatesAsync(state, ctx.getState(), pauseForHost),
  };
}

/**
 * Rebuilds the collection from the event log and compares it with the running one. Events still
 * being saved can make the two differ for a moment, so a mismatch in event counts is re-checked
 * once before it is reported.
 */
export async function runDatabaseCheck(ctx: CheckContext): Promise<DatabaseCheckResult> {
  let result = await rebuildOnce(ctx);
  let changedDuringCheck = result.comparison.rebuiltEvents !== result.comparison.currentEvents;
  if (changedDuringCheck) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    result = await rebuildOnce(ctx);
    changedDuringCheck = result.comparison.rebuiltEvents !== result.comparison.currentEvents;
  }
  return { ...result, changedDuringCheck };
}

function cardRows(state: CollectionState): MaterializedCardRow[] {
  return [...state.cards.values()].map((card) => ({
    id: card.id,
    deck_id: card.deck_id,
    note_id: card.note_id,
    layout_id: card.layout_id,
    due: card.schedule.due,
    schedule: card.schedule,
  }));
}

/**
 * Saves a full rebuild as this device's starting point (local snapshot and cards cache); the
 * caller reloads the app so it runs on it. The event log is not touched. Tabs still on the old
 * collection (this one until it reloads, and others, which are told to reload) stop writing
 * snapshots first, and the saved one is read back to make sure it is the one that stays.
 */
export async function saveRebuiltCollection(
  ctx: CheckContext & { deviceId: string },
  rebuilt: RebuiltCollection,
): Promise<void> {
  const storage = ctx.platform.storage;
  const savedAt = Date.now();
  await storage.setKv(COLLECTION_REBUILT_KV_KEY, savedAt);
  await storage.saveMaterializedCards(cardRows(rebuilt.state));
  await storage.setLocalSnapshot({
    snapshot: serializeCollectionState(rebuilt.state, rebuilt.watermarks),
    localSeq: rebuilt.localSeq,
    savedAt,
  });
  announceRebuild(ctx.deviceId);
  const kept = await storage.getLocalSnapshot();
  if (kept?.savedAt !== savedAt || kept.localSeq !== rebuilt.localSeq) {
    throw new Error('Another tab saved over the rebuild. Close the other tabs and try again.');
  }
}
