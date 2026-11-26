import {
  applyEventsWithDiff,
  deserializeCollectionState,
  formatHlc,
  getTotalAppliedEventCount,
  isSyncTransportError,
  mergeStatePatch,
  receiveHlc,
  serializeCollectionState,
  type CollectionState,
  type CollectionStatePatch,
  type EventFactory,
  type FlashEvent,
  type SerializedCollectionState,
  type SyncCursorState,
} from '@flash/core';
import { createInitialSyncCursor, runSync } from '@flash/core/sync';
import type {
  DeviceMeta,
  MaterializedCardRow,
  PlatformServices,
  ReplayWorkerClient,
  SyncConfig,
  SyncProviderKind,
  SyncTransport,
} from '@flash/platform';
import type { MutableRefObject } from 'react';
import { cardToRow } from './cardRow.ts';
import type { SyncUiState, SyncUiStatus } from './useSyncController.ts';
import { localSnapshotDue } from './localSnapshotCounter.ts';
import { snapshotWriteAllowed } from './rebuildSignal.ts';
import { isNavigatorOnline } from './syncShell.ts';

export function buildWatermarks(
  deviceId: string,
  ownSeq: number,
  cursor?: SyncCursorState,
): Record<string, number> {
  const wm: Record<string, number> = { ...(cursor?.remoteWatermarks ?? {}) };
  if (ownSeq > 0) {
    wm[deviceId] = Math.max(wm[deviceId] ?? 0, ownSeq);
  }
  return wm;
}

/**
 * Runs off-main-thread Web Worker replay while guaranteeing that any local events
 * emitted on the main thread during `worker.hydrate(...)` or `worker.apply(...)`
 * are caught up on the Worker before patches are synchronously merged into `state`.
 */
export async function applyEventsViaWorkerWithConcurrentCatchup(options: {
  worker: ReplayWorkerClient;
  state: CollectionState;
  remoteEvents: readonly FlashEvent[];
  hydrateSnapshot?: () => SerializedCollectionState;
  onHydrated?: () => void;
  drainPendingLocalEvents: () => FlashEvent[];
}): Promise<{ changedCardIds: string[]; removedCardIds: string[] }> {
  if (options.hydrateSnapshot) {
    const snapshot = options.hydrateSnapshot();
    await options.worker.hydrate(snapshot);
    options.onHydrated?.();
  }

  const preLocal = options.drainPendingLocalEvents();
  const initialBatch =
    preLocal.length > 0 ? [...preLocal, ...options.remoteEvents] : options.remoteEvents;

  const patches: CollectionStatePatch[] = [];
  patches.push(await options.worker.apply(initialBatch));

  let concurrent = options.drainPendingLocalEvents();
  while (concurrent.length > 0) {
    patches.push(await options.worker.apply(concurrent));
    concurrent = options.drainPendingLocalEvents();
  }

  // Synchronously merge all accumulated patches (zero await window for interleaving)
  const changedSet = new Set<string>();
  const removedSet = new Set<string>();
  for (const patch of patches) {
    const diff = mergeStatePatch(options.state, patch);
    for (const id of diff.removedCardIds) {
      removedSet.add(id);
      changedSet.delete(id);
    }
    for (const id of diff.changedCardIds) {
      changedSet.add(id);
      removedSet.delete(id);
    }
  }

  return {
    changedCardIds: [...changedSet],
    removedCardIds: [...removedSet],
  };
}

export interface SyncRunnerContext {
  platform: PlatformServices;
  stateRef: MutableRefObject<CollectionState>;
  metaRef: MutableRefObject<DeviceMeta>;
  factoryRef: MutableRefObject<EventFactory>;
  configRef: MutableRefObject<SyncConfig>;
  cursorRef: MutableRefObject<SyncCursorState | undefined>;
  localFolderTransportRef: MutableRefObject<SyncTransport | null>;
  workerRef: MutableRefObject<ReplayWorkerClient | null>;
  workerHydratedRef: MutableRefObject<boolean>;
  workerTrackingLocalRef: MutableRefObject<boolean>;
  pendingWorkerLocalEventsRef: MutableRefObject<FlashEvent[]>;
  reviewsSinceSyncRef: MutableRefObject<number>;
  lastLocalSnapshotCountRef: MutableRefObject<number>;
  lastSyncCompletedAtRef: MutableRefObject<number>;
  /**
   * Bumped each time the user answers the "different collection" question. A sync that started
   * before the answer never raises the question again (see runSyncCycle).
   */
  collectionChoiceEpochRef: MutableRefObject<number>;
  enqueuePersist: (task: () => Promise<void>) => Promise<void>;
  /** When this tab started: a collection rebuilt since then keeps its snapshot (rebuildSignal.ts). */
  startedAtMs?: number;
  onStateMutated: (nextMeta?: DeviceMeta) => void;
  onReplaceState: (nextState: CollectionState, nextMeta: DeviceMeta) => void;
  setSyncState: React.Dispatch<React.SetStateAction<SyncUiState>>;
}

async function ensureReplayWorker(ctx: SyncRunnerContext): Promise<ReplayWorkerClient | null> {
  if (ctx.workerRef.current) return ctx.workerRef.current;
  if (!ctx.platform.createReplayWorker) return null;
  const worker = await ctx.platform.createReplayWorker();
  if (worker) {
    ctx.workerRef.current = worker;
    ctx.workerHydratedRef.current = false;
    ctx.workerTrackingLocalRef.current = false;
  }
  return worker;
}

async function applyRemoteEventsOffMainThread(
  ctx: SyncRunnerContext,
  events: readonly FlashEvent[],
  preSyncCursor?: SyncCursorState,
): Promise<{ changedCardIds: string[]; removedCardIds: string[] }> {
  if (events.length === 0) {
    return { changedCardIds: [], removedCardIds: [] };
  }

  const worker = await ensureReplayWorker(ctx);
  if (worker) {
    try {
      const needsHydrate = !ctx.workerHydratedRef.current;
      return await applyEventsViaWorkerWithConcurrentCatchup({
        worker,
        state: ctx.stateRef.current,
        remoteEvents: events,
        ...(needsHydrate
          ? {
              hydrateSnapshot: () => {
                const snapshot = serializeCollectionState(
                  ctx.stateRef.current,
                  buildWatermarks(
                    ctx.metaRef.current.deviceId,
                    ctx.metaRef.current.seq,
                    preSyncCursor,
                  ),
                );
                ctx.pendingWorkerLocalEventsRef.current = [];
                ctx.workerTrackingLocalRef.current = true;
                return snapshot;
              },
              onHydrated: () => {
                ctx.workerHydratedRef.current = true;
              },
            }
          : {}),
        drainPendingLocalEvents: () => {
          const drained = ctx.pendingWorkerLocalEventsRef.current;
          ctx.pendingWorkerLocalEventsRef.current = [];
          return drained;
        },
      });
    } catch (err) {
      console.warn('Replay worker failed; falling back to main-thread replay:', err);
      worker.terminate();
      ctx.workerRef.current = null;
      ctx.workerHydratedRef.current = false;
      ctx.workerTrackingLocalRef.current = false;
      ctx.pendingWorkerLocalEventsRef.current = [];
    }
  }

  const diff = applyEventsWithDiff(ctx.stateRef.current, events);
  return { changedCardIds: diff.changedCardIds, removedCardIds: diff.removedCardIds };
}

async function restoreLocalFolderTransport(ctx: SyncRunnerContext): Promise<SyncTransport | null> {
  if (ctx.localFolderTransportRef.current) {
    return ctx.localFolderTransportRef.current;
  }
  const restored = await ctx.platform.restoreLocalSyncFolder({ requestPermission: false });
  if (!restored) return null;
  ctx.localFolderTransportRef.current = restored.transport;
  return restored.transport;
}

async function resolveActiveTransport(
  ctx: SyncRunnerContext,
  provider: SyncProviderKind,
): Promise<SyncTransport | null> {
  const platform = ctx.platform;
  switch (provider) {
    case 'dev_channel':
      return platform.syncTransport;
    case 'google_drive':
      return platform.createGoogleDriveTransport();
    case 'dropbox':
      return (await platform.createDropboxTransport?.()) ?? null;
    case 'onedrive':
      return (await platform.createOneDriveTransport?.()) ?? null;
    case 'icloud':
      return (await platform.createICloudTransport?.()) ?? null;
    case 'local_folder':
      return restoreLocalFolderTransport(ctx);
    default:
      return null;
  }
}

export async function runSyncCycle(
  ctx: SyncRunnerContext,
  provider: SyncProviderKind,
): Promise<void> {
  const choiceEpoch = ctx.collectionChoiceEpochRef.current;
  try {
    await ctx.enqueuePersist(async () => {});
    // A Check database rebuild replaced the collection on disk since this tab started: the tab is
    // stale until it reloads (its reload prompt shows), so it stops syncing.
    if (!(await snapshotWriteAllowed(ctx.platform.storage, ctx.startedAtMs))) {
      ctx.setSyncState((prev) => ({ ...prev, status: 'idle' }));
      return;
    }

    const transport = await resolveActiveTransport(ctx, provider);
    if (!transport) {
      ctx.setSyncState((prev) => ({
        ...prev,
        status: provider === 'local_folder' ? 'reconnect_required' : 'disconnected',
        errorMessage:
          provider === 'local_folder'
            ? 'Select or reconnect your local sync folder in Settings.'
            : 'Sync transport is unavailable.',
      }));
      return;
    }

    const currentCursor =
      ctx.cursorRef.current ??
      (await ctx.platform.storage.getSyncCursor()) ??
      createInitialSyncCursor(ctx.metaRef.current.collectionId);
    ctx.cursorRef.current = currentCursor;

    const deviceId = ctx.metaRef.current.deviceId;
    const localOwnSeq = ctx.metaRef.current.seq;
    const canBootstrap = ctx.stateRef.current.decks.size === 0 && localOwnSeq === 0;

    // An add-device link names the collection this device should join. Fresh devices only.
    let expectedCollectionId: string | undefined;
    if (
      currentCursor.collectionId === undefined &&
      ctx.metaRef.current.collectionId === undefined
    ) {
      const { addDeviceExpectationResource } = await import('../sync/addDeviceExpectation.ts');
      const expected = await addDeviceExpectationResource(ctx.platform.storage);
      if (expected?.provider === provider) expectedCollectionId = expected.collectionId;
    }

    const result = await runSync({
      transport,
      ...(expectedCollectionId !== undefined ? { expectedCollectionId } : {}),
      deviceId,
      cursor: currentCursor,
      localOwnSeq,
      currentTotalEvents: getTotalAppliedEventCount(ctx.stateRef.current),
      canBootstrapFromSnapshot: canBootstrap,
      getLocalEventsAfterSeq: (afterSeq) =>
        ctx.platform.storage.getDeviceEventsAfterSeq(deviceId, afterSeq),
      mediaStore: {
        getLocalMedia: (hash) => ctx.platform.storage.getMedia(hash),
        putLocalMedia: (media) => ctx.platform.storage.putMedia(media),
      },
      knownMediaEntries: [...ctx.stateRef.current.media.values()],
      buildSnapshotState: async (pulledEvents, hydratedSnap) => {
        const baseSerialized = hydratedSnap
          ? hydratedSnap.state
          : serializeCollectionState(
              ctx.stateRef.current,
              buildWatermarks(deviceId, localOwnSeq, currentCursor),
            );
        const snapState = deserializeCollectionState(baseSerialized);
        if (pulledEvents.length > 0) {
          applyEventsWithDiff(snapState, pulledEvents);
        }
        const watermarks = buildWatermarks(deviceId, localOwnSeq, currentCursor);
        return {
          state: serializeCollectionState(snapState, watermarks),
          totalEvents: getTotalAppliedEventCount(snapState),
          watermarks,
        };
      },
    });

    if (result.status === 'collection_choice_required') {
      // Nothing was bound, pulled or pushed: wait for the user's choice (see resolveCollectionChoice).
      // The user answered while this sync was running (it read the old add-device link): the
      // answer stands, and this stale result must not ask again.
      if (ctx.collectionChoiceEpochRef.current !== choiceEpoch) return;
      ctx.setSyncState(({ errorMessage: _stale, ...prev }) => ({
        ...prev,
        status: 'idle',
        readOnly: true,
        errorMessage:
          'This account holds a different collection from the device that showed the code. Choose below which one to use; nothing has been changed yet.',
        pendingCount: Math.max(0, ctx.metaRef.current.seq - currentCursor.lastPushedSeq),
        collectionChoice: {
          expectedCollectionId: expectedCollectionId ?? '',
          remoteCollectionId: result.collectionId ?? '',
        },
      }));
      return;
    }

    ctx.cursorRef.current = result.cursor;
    ctx.reviewsSinceSyncRef.current = 0;
    ctx.lastSyncCompletedAtRef.current = result.cursor.lastSyncedAt ?? Date.now();

    if (result.status === 'collection_mismatch') {
      ctx.setSyncState((prev) => ({
        ...prev,
        status: 'error',
        readOnly: true,
        errorMessage:
          result.message ?? 'Sync store belongs to a different collection. Disconnect first.',
      }));
      return;
    }

    let nextMeta: DeviceMeta = ctx.metaRef.current;
    let metaChanged = false;
    if (result.collectionId && nextMeta.collectionId !== result.collectionId) {
      nextMeta = { ...nextMeta, collectionId: result.collectionId };
      metaChanged = true;
    }
    const remoteOwnSeq = Math.max(
      result.cursor.lastPushedSeq,
      result.cursor.remoteWatermarks[deviceId] ?? 0,
    );
    if (remoteOwnSeq > nextMeta.seq) {
      nextMeta = { ...nextMeta, seq: remoteOwnSeq };
      ctx.factoryRef.current.setSeq(remoteOwnSeq);
      metaChanged = true;
    }
    if (result.maxRemoteHlc) {
      const mergedHlc = receiveHlc(nextMeta.hlc, result.maxRemoteHlc, Date.now());
      nextMeta = { ...nextMeta, hlc: mergedHlc };
      ctx.factoryRef.current.setHlc(mergedHlc);
      metaChanged = true;
    }

    if (result.hydratedSnapshot) {
      const hydrated = deserializeCollectionState(result.hydratedSnapshot.state);
      if (result.pulledEvents.length > 0) {
        applyEventsWithDiff(hydrated, result.pulledEvents);
      }
      if (ctx.metaRef.current.seq > localOwnSeq) {
        // Local events made since the sync started are replayed over the snapshot. Each read
        // awaits, and a rating made during it is persisted after it, so read again until no new
        // local event appeared; the last check and `onReplaceState` run with no await between (D20).
        let caughtUpSeq = localOwnSeq;
        while (ctx.metaRef.current.seq > caughtUpSeq) {
          const targetSeq = ctx.metaRef.current.seq;
          await ctx.enqueuePersist(async () => {});
          const concurrentLocal = await ctx.platform.storage.getDeviceEventsAfterSeq(
            deviceId,
            caughtUpSeq,
          );
          if (concurrentLocal.length > 0) {
            applyEventsWithDiff(hydrated, concurrentLocal);
          }
          // Events up to `targetSeq` were queued before the barrier, so they are on disk now (a
          // failed write is the persist queue's to report); later ones go round again.
          caughtUpSeq = concurrentLocal.reduce((max, e) => Math.max(max, e.seq), targetSeq);
        }
        nextMeta = {
          ...nextMeta,
          seq: Math.max(nextMeta.seq, ctx.metaRef.current.seq),
          hlc: receiveHlc(nextMeta.hlc, formatHlc(ctx.metaRef.current.hlc), Date.now()),
        };
        ctx.factoryRef.current.setSeq(nextMeta.seq);
        ctx.factoryRef.current.setHlc(nextMeta.hlc);
      }
      ctx.workerHydratedRef.current = false;
      ctx.workerTrackingLocalRef.current = false;
      ctx.pendingWorkerLocalEventsRef.current = [];
      ctx.onReplaceState(hydrated, nextMeta);

      const allCardRows = [...hydrated.cards.values()].map((card) => cardToRow(card));
      const snapWatermarks = buildWatermarks(deviceId, nextMeta.seq, result.cursor);
      const localSnapPayload = serializeCollectionState(hydrated, snapWatermarks);

      void ctx.enqueuePersist(async () => {
        if (result.pulledEvents.length > 0) {
          await ctx.platform.storage.appendEvents(result.pulledEvents);
        }
        // The hydrated state only reaches storage through this snapshot. When a rebuild keeps the
        // snapshot, the cursor must not move past it either: the next sync after reload pulls again.
        if (!(await snapshotWriteAllowed(ctx.platform.storage, ctx.startedAtMs))) return;
        await ctx.platform.storage.saveMaterializedCards(allCardRows);
        await ctx.platform.storage.setDeviceMeta(nextMeta);
        await ctx.platform.storage.setSyncCursor(result.cursor);
        const maxLocalSeq = await ctx.platform.storage.getMaxLocalSeq();
        await ctx.platform.storage.setLocalSnapshot({
          snapshot: localSnapPayload,
          localSeq: maxLocalSeq,
          savedAt: Date.now(),
        });
        ctx.lastLocalSnapshotCountRef.current = getTotalAppliedEventCount(hydrated);
      });
    } else if (result.pulledEvents.length > 0) {
      const diff = await applyRemoteEventsOffMainThread(ctx, result.pulledEvents, currentCursor);
      ctx.onStateMutated(metaChanged ? nextMeta : undefined);

      const changedRows: MaterializedCardRow[] = [];
      for (const cardId of diff.changedCardIds) {
        const card = ctx.stateRef.current.cards.get(cardId);
        if (card) changedRows.push(cardToRow(card));
      }

      const totalNow = getTotalAppliedEventCount(ctx.stateRef.current);
      const shouldSaveLocalSnapshot =
        localSnapshotDue(ctx.lastLocalSnapshotCountRef, totalNow) ||
        result.pulledEvents.length >= 100;
      const localSnapPayload = shouldSaveLocalSnapshot
        ? serializeCollectionState(
            ctx.stateRef.current,
            buildWatermarks(deviceId, nextMeta.seq, result.cursor),
          )
        : null;
      // Moved when the snapshot is decided, as a local edit does, so an edit queued before this
      // write runs doesn't take a second snapshot of the same events (R10).
      if (localSnapPayload) ctx.lastLocalSnapshotCountRef.current = totalNow;

      void ctx.enqueuePersist(async () => {
        await ctx.platform.storage.appendEvents(result.pulledEvents);
        if (changedRows.length > 0) {
          await ctx.platform.storage.upsertMaterializedCards(changedRows);
        }
        if (diff.removedCardIds.length > 0) {
          await ctx.platform.storage.deleteMaterializedCards(diff.removedCardIds);
        }
        if (metaChanged) {
          await ctx.platform.storage.setDeviceMeta(nextMeta);
        }
        await ctx.platform.storage.setSyncCursor(result.cursor);
        if (
          localSnapPayload &&
          (await snapshotWriteAllowed(ctx.platform.storage, ctx.startedAtMs))
        ) {
          const maxLocalSeq = await ctx.platform.storage.getMaxLocalSeq();
          await ctx.platform.storage.setLocalSnapshot({
            snapshot: localSnapPayload,
            localSeq: maxLocalSeq,
            savedAt: Date.now(),
          });
        }
      });
    } else {
      if (metaChanged || (result.pulledMediaCount ?? 0) > 0) {
        ctx.onStateMutated(metaChanged ? nextMeta : undefined);
      }
      void ctx.enqueuePersist(async () => {
        if (metaChanged) {
          await ctx.platform.storage.setDeviceMeta(nextMeta);
        }
        await ctx.platform.storage.setSyncCursor(result.cursor);
      });
    }

    const notice = result.message ?? result.pullWarnings?.[0];
    ctx.setSyncState({
      provider,
      status: result.readOnly ? 'upgrade_required' : 'synced',
      isOnline: isNavigatorOnline(),
      readOnly: result.readOnly,
      ...(result.cursor.lastSyncedAt !== undefined
        ? { lastSyncedAt: result.cursor.lastSyncedAt }
        : {}),
      ...(ctx.configRef.current.localFolderName !== undefined
        ? { localFolderName: ctx.configRef.current.localFolderName }
        : {}),
      pendingCount: Math.max(0, ctx.metaRef.current.seq - result.cursor.lastPushedSeq),
      // A segment another device wrote that could not be read is retried; say so in Settings.
      ...(notice !== undefined ? { errorMessage: notice } : {}),
      lastPulledCount: result.pulledEvents.length,
      lastPushedCount: result.pushedEventCount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    let nextStatus: SyncUiStatus = 'error';
    if (isSyncTransportError(err)) {
      if (err.code === 'AUTH_REQUIRED' || err.code === 'PERMISSION_DENIED') {
        nextStatus = 'reconnect_required';
      } else if (err.code === 'NETWORK' && !isNavigatorOnline()) {
        nextStatus = 'offline';
      }
    } else if (!isNavigatorOnline()) {
      nextStatus = 'offline';
    }

    ctx.setSyncState((prev) => ({
      ...prev,
      isOnline: isNavigatorOnline(),
      status: nextStatus,
      pendingCount: Math.max(
        0,
        ctx.metaRef.current.seq - (ctx.cursorRef.current?.lastPushedSeq ?? 0),
      ),
      errorMessage: msg,
    }));
  }
}

export async function connectLocalFolderSync(
  ctx: SyncRunnerContext,
  clearCollectionBinding: () => DeviceMeta,
): Promise<boolean> {
  const picked = await ctx.platform.pickLocalSyncFolder();
  if (!picked) return false;

  ctx.localFolderTransportRef.current = picked.transport;
  const nextConfig: SyncConfig = {
    provider: 'local_folder',
    connectedAt: Date.now(),
    localFolderName: picked.name,
  };
  ctx.configRef.current = nextConfig;

  const freshCursor = createInitialSyncCursor();
  ctx.cursorRef.current = freshCursor;
  const clearedMeta = clearCollectionBinding();

  await ctx.enqueuePersist(async () => {
    await ctx.platform.storage.setSyncConfig(nextConfig);
    await ctx.platform.storage.setSyncCursor(freshCursor);
    await ctx.platform.storage.setDeviceMeta(clearedMeta);
  });

  ctx.setSyncState((prev) => ({
    provider: 'local_folder',
    status: 'idle',
    isOnline: prev.isOnline,
    readOnly: false,
    localFolderName: picked.name,
    pendingCount: Math.max(0, ctx.metaRef.current.seq - freshCursor.lastPushedSeq),
    lastPulledCount: 0,
    lastPushedCount: 0,
  }));

  return true;
}

/**
 * Makes a signed-in cloud provider the active sync target without a page redirect (used after a
 * GIS tap-to-renew sign-in). A provider switch starts a fresh cursor and collection binding.
 */
export async function activateCloudProvider(
  ctx: SyncRunnerContext,
  provider: 'google_drive' | 'dropbox' | 'icloud' | 'onedrive',
  clearCollectionBinding: () => DeviceMeta,
): Promise<void> {
  if (ctx.configRef.current.provider === provider) return;
  const nextConfig: SyncConfig = { provider, connectedAt: Date.now() };
  ctx.configRef.current = nextConfig;
  const freshCursor = createInitialSyncCursor();
  ctx.cursorRef.current = freshCursor;
  const clearedMeta = clearCollectionBinding();
  await ctx.enqueuePersist(async () => {
    await ctx.platform.storage.setSyncConfig(nextConfig);
    await ctx.platform.storage.setSyncCursor(freshCursor);
    await ctx.platform.storage.setDeviceMeta(clearedMeta);
  });
  ctx.setSyncState((prev) => ({
    provider,
    status: 'idle',
    isOnline: prev.isOnline,
    readOnly: false,
    pendingCount: Math.max(0, ctx.metaRef.current.seq - freshCursor.lastPushedSeq),
    lastPulledCount: 0,
    lastPushedCount: 0,
  }));
}

export async function disconnectActiveSync(
  ctx: SyncRunnerContext,
  clearCollectionBinding: () => DeviceMeta,
): Promise<void> {
  const prevProvider = ctx.configRef.current.provider;
  if (prevProvider === 'google_drive') {
    const auth = await ctx.platform.getGoogleAuth();
    await auth.signOut();
  } else if (prevProvider === 'dropbox' && ctx.platform.getDropboxAuth) {
    const auth = await ctx.platform.getDropboxAuth();
    await auth.signOut();
  } else if (prevProvider === 'onedrive' && ctx.platform.getOneDriveAuth) {
    const auth = await ctx.platform.getOneDriveAuth();
    await auth.signOut();
  } else if (prevProvider === 'local_folder') {
    ctx.localFolderTransportRef.current = null;
    await ctx.platform.disconnectLocalSyncFolder();
  }

  const nextConfig: SyncConfig = { provider: 'none' };
  ctx.configRef.current = nextConfig;
  const freshCursor = createInitialSyncCursor();
  ctx.cursorRef.current = freshCursor;
  const clearedMeta = clearCollectionBinding();

  await ctx.enqueuePersist(async () => {
    await ctx.platform.storage.setSyncConfig(nextConfig);
    await ctx.platform.storage.setSyncCursor(freshCursor);
    await ctx.platform.storage.setDeviceMeta(clearedMeta);
  });

  ctx.setSyncState({
    provider: 'none',
    status: 'disconnected',
    isOnline: isNavigatorOnline(),
    readOnly: false,
    pendingCount: 0,
    lastPulledCount: 0,
    lastPushedCount: 0,
  });
}
