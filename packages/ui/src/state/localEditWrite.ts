import type { Card, KnownEvent } from '@flash/core';
import type { DeviceMeta, MaterializedCardRow, PlatformServices } from '@flash/platform';
import type * as SnapshotApi from '@flash/core/snapshot';
import { snapshotWriteAllowed } from './rebuildSignal.ts';

/**
 * The storage write behind each local edit (`emitEvents`). AppProvider applies the events in
 * memory at once and queues this write on its persist queue, which keeps a failed write and runs
 * it again on Retry; it is kept apart so that path is tested without rendering (§9).
 */

export type SerializedSnapshot = ReturnType<(typeof SnapshotApi)['serializeCollectionState']>;

export function cardToRow(card: Card): MaterializedCardRow {
  return {
    id: card.id,
    deck_id: card.deck_id,
    note_id: card.note_id,
    layout_id: card.layout_id,
    due: card.schedule.due,
    schedule: card.schedule,
  };
}

/**
 * Saves a snapshot serialized when its write was queued (D18): the queue has appended exactly the
 * events it holds by the time this runs, so `localSeq` matches it. Skipped when a newer Check
 * rebuild owns the snapshot (rebuildSignal.ts).
 */
export async function saveLocalSnapshot(
  storage: PlatformServices['storage'],
  startedAtMs: number,
  snapshot: SerializedSnapshot,
): Promise<void> {
  if (!(await snapshotWriteAllowed(storage, startedAtMs))) return;
  await storage.setLocalSnapshot({
    snapshot,
    localSeq: await storage.getMaxLocalSeq(),
    savedAt: Date.now(),
  });
}

export interface LocalEditWrite {
  events: readonly KnownEvent[];
  changedRows: readonly MaterializedCardRow[];
  removedIds: readonly string[];
  meta: DeviceMeta;
  snapshot?: SerializedSnapshot;
}

/**
 * One edit's write, in order: the events first (the log is the truth), then the card cache, the
 * device meta and any snapshot. Idempotent, so the persist queue can run it again after a failure.
 */
export function localEditWriter(
  storage: PlatformServices['storage'],
  startedAtMs: number,
  write: LocalEditWrite,
): () => Promise<void> {
  return async () => {
    await storage.appendEvents(write.events);
    if (write.changedRows.length > 0) await storage.upsertMaterializedCards(write.changedRows);
    if (write.removedIds.length > 0) await storage.deleteMaterializedCards(write.removedIds);
    await storage.setDeviceMeta(write.meta);
    if (write.snapshot) await saveLocalSnapshot(storage, startedAtMs, write.snapshot);
  };
}
