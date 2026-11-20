import {
  applyEventsWithDiff,
  deserializeCollectionState,
  formatHlc,
  getTotalAppliedEventCount,
  isSyncTransportError,
  mergeStatePatch,
  receiveHlc,
  serializeCollectionState,
  type Card,
  type CollectionState,
  type CollectionStatePatch,
  type EventFactory,
  type FlashEvent,
  type SerializedCollectionState,
  type SyncCursorState,
} from '@flash/core';
import type {
  DeviceMeta,
  MaterializedCardRow,
  PlatformServices,
  ReplayWorkerClient,
  SyncConfig,
  SyncProviderKind,
  SyncTransport,
} from '@flash/platform';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

export type SyncUiStatus =
  | 'disconnected'
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'reconnect_required'
  | 'upgrade_required'
  | 'error';

export interface SyncUiState {
  provider: SyncProviderKind;
  status: SyncUiStatus;
  isOnline: boolean;
  readOnly: boolean;
  lastSyncedAt?: number;
  localFolderName?: string;
  pendingCount: number;
  errorMessage?: string;
  lastPulledCount: number;
  lastPushedCount: number;
}

export interface SyncController {
  syncState: SyncUiState;
  syncNow: (opts?: { silent?: boolean }) => Promise<void>;
  connectGoogleDrive: () => Promise<void>;
  connectLocalFolder: () => Promise<boolean>;
  reconnectLocalFolder: () => Promise<boolean>;
  disconnectSync: () => Promise<void>;
  notifyLocalEvents: (events: readonly FlashEvent[], reviewCount?: number) => void;
  getCurrentWatermarks: () => Record<string, number>;
  resetSyncState: () => void;
}

export interface UseSyncControllerOptions {
  platform: PlatformServices;
  stateRef: MutableRefObject<CollectionState>;
  metaRef: MutableRefObject<DeviceMeta>;
  factoryRef: MutableRefObject<EventFactory>;
  initialSyncConfig?: SyncConfig;
  initialSyncCursor?: SyncCursorState;
  initialOAuthError?: string;
  enqueuePersist: (task: () => Promise<void>) => Promise<void>;
  onStateMutated: (nextMeta?: DeviceMeta) => void;
  onReplaceState: (nextState: CollectionState, nextMeta: DeviceMeta) => void;
}

const REVIEWS_PER_AUTO_SYNC = 20;
const AUTO_SYNC_INTERVAL_MS = 120_000;
const LOCAL_SNAPSHOT_EVENT_THRESHOLD = 200;

function isNavigatorOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

function cardToRow(card: Card): MaterializedCardRow {
  return {
    id: card.id,
    deck_id: card.deck_id,
    note_id: card.note_id,
    layout_id: card.layout_id,
    due: card.schedule.due,
    schedule: card.schedule,
  };
}

function buildWatermarks(
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

export function useSyncController({
  platform,
  stateRef,
  metaRef,
  factoryRef,
  initialSyncConfig,
  initialSyncCursor,
  initialOAuthError,
  enqueuePersist,
  onStateMutated,
  onReplaceState,
}: UseSyncControllerOptions): SyncController {
  const defaultProvider: SyncProviderKind =
    initialSyncConfig?.provider ?? (platform.hasDeviceSlug ? 'dev_channel' : 'none');

  const configRef = useRef<SyncConfig>(
    initialSyncConfig ?? {
      provider: defaultProvider,
    },
  );
  const cursorRef = useRef<SyncCursorState | undefined>(initialSyncCursor);
  const localFolderTransportRef = useRef<SyncTransport | null>(null);
  const workerRef = useRef<ReplayWorkerClient | null>(null);
  const workerHydratedRef = useRef<boolean>(false);
  const workerTrackingLocalRef = useRef<boolean>(false);
  const pendingWorkerLocalEventsRef = useRef<FlashEvent[]>([]);
  const reviewsSinceSyncRef = useRef<number>(0);
  const lastLocalSnapshotCountRef = useRef<number>(getTotalAppliedEventCount(stateRef.current));
  const inFlightRef = useRef<boolean>(false);
  const queuedRef = useRef<boolean>(false);

  const [syncState, setSyncState] = useState<SyncUiState>(() => {
    const online = isNavigatorOnline();
    const pendingCount = Math.max(0, metaRef.current.seq - (initialSyncCursor?.lastPushedSeq ?? 0));
    const status: SyncUiStatus = initialOAuthError
      ? 'error'
      : defaultProvider === 'none'
        ? 'disconnected'
        : !online && (defaultProvider === 'google_drive' || defaultProvider === 'dev_channel')
          ? 'offline'
          : initialSyncCursor?.lastSyncedAt
            ? 'synced'
            : 'idle';
    return {
      provider: defaultProvider,
      status,
      isOnline: online,
      readOnly: false,
      ...(initialSyncCursor?.lastSyncedAt !== undefined
        ? { lastSyncedAt: initialSyncCursor.lastSyncedAt }
        : {}),
      ...(initialSyncConfig?.localFolderName !== undefined
        ? { localFolderName: initialSyncConfig.localFolderName }
        : {}),
      pendingCount,
      ...(initialOAuthError !== undefined ? { errorMessage: initialOAuthError } : {}),
      lastPulledCount: 0,
      lastPushedCount: 0,
    };
  });

  // Clean up Web Worker on unmount
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      workerHydratedRef.current = false;
      workerTrackingLocalRef.current = false;
    };
  }, []);

  const ensureReplayWorker = useCallback(async (): Promise<ReplayWorkerClient | null> => {
    if (workerRef.current) return workerRef.current;
    if (!platform.createReplayWorker) return null;
    const worker = await platform.createReplayWorker();
    if (worker) {
      workerRef.current = worker;
      workerHydratedRef.current = false;
      workerTrackingLocalRef.current = false;
    }
    return worker;
  }, [platform]);

  const applyRemoteEventsOffMainThread = useCallback(
    async (
      events: readonly FlashEvent[],
      preSyncCursor?: SyncCursorState,
    ): Promise<{ changedCardIds: string[]; removedCardIds: string[] }> => {
      if (events.length === 0) {
        return { changedCardIds: [], removedCardIds: [] };
      }

      const worker = await ensureReplayWorker();
      if (worker) {
        try {
          const needsHydrate = !workerHydratedRef.current;
          return await applyEventsViaWorkerWithConcurrentCatchup({
            worker,
            state: stateRef.current,
            remoteEvents: events,
            ...(needsHydrate
              ? {
                  hydrateSnapshot: () => {
                    // Snapshot synchronously and begin capturing any concurrent local events
                    // BEFORE awaiting `worker.hydrate(...)`.
                    const snapshot = serializeCollectionState(
                      stateRef.current,
                      buildWatermarks(metaRef.current.deviceId, metaRef.current.seq, preSyncCursor),
                    );
                    pendingWorkerLocalEventsRef.current = [];
                    workerTrackingLocalRef.current = true;
                    return snapshot;
                  },
                  onHydrated: () => {
                    workerHydratedRef.current = true;
                  },
                }
              : {}),
            drainPendingLocalEvents: () => {
              const drained = pendingWorkerLocalEventsRef.current;
              pendingWorkerLocalEventsRef.current = [];
              return drained;
            },
          });
        } catch (err) {
          console.warn('Replay worker failed; falling back to main-thread replay:', err);
          worker.terminate();
          workerRef.current = null;
          workerHydratedRef.current = false;
          workerTrackingLocalRef.current = false;
          pendingWorkerLocalEventsRef.current = [];
        }
      }

      const diff = applyEventsWithDiff(stateRef.current, events);
      return { changedCardIds: diff.changedCardIds, removedCardIds: diff.removedCardIds };
    },
    [ensureReplayWorker, metaRef, stateRef],
  );

  const resolveActiveTransport = useCallback(
    async (provider: SyncProviderKind): Promise<SyncTransport | null> => {
      if (provider === 'none') return null;
      if (provider === 'dev_channel') {
        return platform.syncTransport;
      }
      if (provider === 'google_drive') {
        return platform.createGoogleDriveTransport();
      }
      if (provider === 'local_folder') {
        if (localFolderTransportRef.current) {
          return localFolderTransportRef.current;
        }
        const restored = await platform.restoreLocalSyncFolder({ requestPermission: false });
        if (!restored) return null;
        localFolderTransportRef.current = restored.transport;
        return restored.transport;
      }
      return null;
    },
    [platform],
  );

  const executeSync = useCallback(async (): Promise<void> => {
    const provider = configRef.current.provider;
    if (provider === 'none') return;

    const online = isNavigatorOnline();
    if (!online && (provider === 'google_drive' || provider === 'dev_channel')) {
      setSyncState((prev) => ({
        ...prev,
        isOnline: false,
        status: 'offline',
        pendingCount: Math.max(0, metaRef.current.seq - (cursorRef.current?.lastPushedSeq ?? 0)),
      }));
      return;
    }

    if (inFlightRef.current) {
      queuedRef.current = true;
      return;
    }

    inFlightRef.current = true;
    setSyncState((prev) => ({
      ...prev,
      provider,
      isOnline: online,
      status: 'syncing',
    }));

    try {
      // Flush any in-flight optimistic local writes to IndexedDB before reading local device events
      await enqueuePersist(async () => {});

      const transport = await resolveActiveTransport(provider);
      if (!transport) {
        setSyncState((prev) => ({
          ...prev,
          status: provider === 'local_folder' ? 'reconnect_required' : 'disconnected',
          errorMessage:
            provider === 'local_folder'
              ? 'Select or reconnect your local sync folder in Settings.'
              : 'Sync transport is unavailable.',
        }));
        return;
      }

      const { createInitialSyncCursor, runSync } = await import('@flash/core/sync');
      const currentCursor =
        cursorRef.current ??
        (await platform.storage.getSyncCursor()) ??
        createInitialSyncCursor(metaRef.current.collectionId);
      cursorRef.current = currentCursor;

      const deviceId = metaRef.current.deviceId;
      const localOwnSeq = metaRef.current.seq;
      const canBootstrap = stateRef.current.decks.size === 0 && localOwnSeq === 0;

      const result = await runSync({
        transport,
        deviceId,
        cursor: currentCursor,
        localOwnSeq,
        currentTotalEvents: getTotalAppliedEventCount(stateRef.current),
        canBootstrapFromSnapshot: canBootstrap,
        getLocalEventsAfterSeq: (afterSeq) =>
          platform.storage.getDeviceEventsAfterSeq(deviceId, afterSeq),
        buildSnapshotState: async (pulledEvents, hydratedSnap) => {
          const baseSerialized = hydratedSnap
            ? hydratedSnap.state
            : serializeCollectionState(
                stateRef.current,
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

      cursorRef.current = result.cursor;
      reviewsSinceSyncRef.current = 0;

      if (result.status === 'collection_mismatch') {
        setSyncState((prev) => ({
          ...prev,
          status: 'error',
          readOnly: true,
          errorMessage:
            result.message ?? 'Sync store belongs to a different collection. Disconnect first.',
        }));
        return;
      }

      // Compute next DeviceMeta (collection binding, own-seq catchup after recovery, receiveHlc)
      let nextMeta: DeviceMeta = metaRef.current;
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
        factoryRef.current.setSeq(remoteOwnSeq);
        metaChanged = true;
      }
      if (result.maxRemoteHlc) {
        const mergedHlc = receiveHlc(nextMeta.hlc, result.maxRemoteHlc, Date.now());
        nextMeta = { ...nextMeta, hlc: mergedHlc };
        factoryRef.current.setHlc(mergedHlc);
        metaChanged = true;
      }

      if (result.hydratedSnapshot) {
        const hydrated = deserializeCollectionState(result.hydratedSnapshot.state);
        if (result.pulledEvents.length > 0) {
          applyEventsWithDiff(hydrated, result.pulledEvents);
        }
        // Preserve any local events emitted concurrently while the remote snapshot was downloading
        if (metaRef.current.seq > localOwnSeq) {
          await enqueuePersist(async () => {});
          const concurrentLocal = await platform.storage.getDeviceEventsAfterSeq(
            deviceId,
            localOwnSeq,
          );
          if (concurrentLocal.length > 0) {
            applyEventsWithDiff(hydrated, concurrentLocal);
          }
          nextMeta = {
            ...nextMeta,
            seq: Math.max(nextMeta.seq, metaRef.current.seq),
            hlc: receiveHlc(nextMeta.hlc, formatHlc(metaRef.current.hlc), Date.now()),
          };
          factoryRef.current.setSeq(nextMeta.seq);
          factoryRef.current.setHlc(nextMeta.hlc);
        }
        workerHydratedRef.current = false;
        workerTrackingLocalRef.current = false;
        pendingWorkerLocalEventsRef.current = [];
        onReplaceState(hydrated, nextMeta);

        const allCardRows = [...hydrated.cards.values()].map(cardToRow);
        const snapWatermarks = buildWatermarks(deviceId, nextMeta.seq, result.cursor);
        const localSnapPayload = serializeCollectionState(hydrated, snapWatermarks);

        void enqueuePersist(async () => {
          if (result.pulledEvents.length > 0) {
            await platform.storage.appendEvents(result.pulledEvents);
          }
          await platform.storage.saveMaterializedCards(allCardRows);
          await platform.storage.setDeviceMeta(nextMeta);
          await platform.storage.setSyncCursor(result.cursor);
          const maxLocalSeq = await platform.storage.getMaxLocalSeq();
          await platform.storage.setLocalSnapshot({
            snapshot: localSnapPayload,
            localSeq: maxLocalSeq,
            savedAt: Date.now(),
          });
          lastLocalSnapshotCountRef.current = getTotalAppliedEventCount(hydrated);
        });
      } else if (result.pulledEvents.length > 0) {
        const diff = await applyRemoteEventsOffMainThread(result.pulledEvents, currentCursor);
        onStateMutated(metaChanged ? nextMeta : undefined);

        const changedRows: MaterializedCardRow[] = [];
        for (const cardId of diff.changedCardIds) {
          const card = stateRef.current.cards.get(cardId);
          if (card) changedRows.push(cardToRow(card));
        }

        const totalNow = getTotalAppliedEventCount(stateRef.current);
        const shouldSaveLocalSnapshot =
          totalNow - lastLocalSnapshotCountRef.current >= LOCAL_SNAPSHOT_EVENT_THRESHOLD ||
          result.pulledEvents.length >= 100;
        const localSnapPayload = shouldSaveLocalSnapshot
          ? serializeCollectionState(
              stateRef.current,
              buildWatermarks(deviceId, nextMeta.seq, result.cursor),
            )
          : null;

        void enqueuePersist(async () => {
          await platform.storage.appendEvents(result.pulledEvents);
          if (changedRows.length > 0) {
            await platform.storage.upsertMaterializedCards(changedRows);
          }
          if (diff.removedCardIds.length > 0) {
            await platform.storage.deleteMaterializedCards(diff.removedCardIds);
          }
          if (metaChanged) {
            await platform.storage.setDeviceMeta(nextMeta);
          }
          await platform.storage.setSyncCursor(result.cursor);
          if (localSnapPayload) {
            const maxLocalSeq = await platform.storage.getMaxLocalSeq();
            await platform.storage.setLocalSnapshot({
              snapshot: localSnapPayload,
              localSeq: maxLocalSeq,
              savedAt: Date.now(),
            });
            lastLocalSnapshotCountRef.current = totalNow;
          }
        });
      } else {
        if (metaChanged) {
          onStateMutated(nextMeta);
        }
        void enqueuePersist(async () => {
          if (metaChanged) {
            await platform.storage.setDeviceMeta(nextMeta);
          }
          await platform.storage.setSyncCursor(result.cursor);
        });
      }

      setSyncState({
        provider,
        status: result.readOnly ? 'upgrade_required' : 'synced',
        isOnline: isNavigatorOnline(),
        readOnly: result.readOnly,
        ...(result.cursor.lastSyncedAt !== undefined
          ? { lastSyncedAt: result.cursor.lastSyncedAt }
          : {}),
        ...(configRef.current.localFolderName !== undefined
          ? { localFolderName: configRef.current.localFolderName }
          : {}),
        pendingCount: Math.max(0, metaRef.current.seq - result.cursor.lastPushedSeq),
        ...(result.message !== undefined ? { errorMessage: result.message } : {}),
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

      setSyncState((prev) => ({
        ...prev,
        isOnline: isNavigatorOnline(),
        status: nextStatus,
        pendingCount: Math.max(0, metaRef.current.seq - (cursorRef.current?.lastPushedSeq ?? 0)),
        errorMessage: msg,
      }));
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void executeSync();
      }
    }
  }, [
    applyRemoteEventsOffMainThread,
    enqueuePersist,
    factoryRef,
    metaRef,
    onReplaceState,
    onStateMutated,
    platform.storage,
    resolveActiveTransport,
    stateRef,
  ]);

  const syncNow = useCallback(async (): Promise<void> => {
    await executeSync();
  }, [executeSync]);

  // Trigger 1: App open (after first paint) for connected cloud / local-folder providers
  useEffect(() => {
    const provider = configRef.current.provider;
    if (provider === 'google_drive' || provider === 'local_folder') {
      const timer = window.setTimeout(() => {
        void executeSync();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [executeSync]);

  // Trigger 2: Network reconnect (`online` / `offline`)
  useEffect(() => {
    const onOnline = () => {
      setSyncState((prev) => ({ ...prev, isOnline: true }));
      if (configRef.current.provider !== 'none') {
        void executeSync();
      }
    };
    const onOffline = () => {
      setSyncState((prev) => ({
        ...prev,
        isOnline: false,
        status:
          prev.provider === 'google_drive' || prev.provider === 'dev_channel'
            ? 'offline'
            : prev.status,
      }));
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [executeSync]);

  // Trigger 3: Backgrounding (`visibilitychange` -> hidden, `pagehide`) push when pending events exist
  useEffect(() => {
    const pushIfPending = () => {
      const provider = configRef.current.provider;
      if (provider === 'none') return;
      const pending = Math.max(0, metaRef.current.seq - (cursorRef.current?.lastPushedSeq ?? 0));
      if (pending > 0) {
        void executeSync();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        pushIfPending();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', pushIfPending);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', pushIfPending);
    };
  }, [executeSync, metaRef]);

  // Trigger 4b: Every 2 minutes while active
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (configRef.current.provider === 'none') return;
      if (document.visibilityState !== 'visible') return;
      void executeSync();
    }, AUTO_SYNC_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [executeSync]);

  // Trigger 6: Dev-mode BroadcastChannel live cross-tab notifications (?device=a <-> ?device=b)
  useEffect(() => {
    if (!platform.onDevSyncNotification) return undefined;
    return platform.onDevSyncNotification((path) => {
      if (configRef.current.provider !== 'dev_channel') return;
      if (!path.endsWith('/head.json')) return;
      const ownMarker = `/${metaRef.current.deviceId}/head.json`;
      if (path.endsWith(ownMarker)) return;
      void executeSync();
    });
  }, [executeSync, metaRef, platform]);

  // Trigger 4a: Track local mutations & every 20 reviews auto-sync
  const notifyLocalEvents = useCallback(
    (events: readonly FlashEvent[], reviewCount = 0) => {
      if ((workerHydratedRef.current || workerTrackingLocalRef.current) && events.length > 0) {
        pendingWorkerLocalEventsRef.current.push(...events);
      }

      const pendingCount = Math.max(
        0,
        metaRef.current.seq - (cursorRef.current?.lastPushedSeq ?? 0),
      );
      setSyncState((prev) =>
        prev.pendingCount === pendingCount ? prev : { ...prev, pendingCount },
      );

      if (reviewCount > 0 && configRef.current.provider !== 'none') {
        reviewsSinceSyncRef.current += reviewCount;
        if (reviewsSinceSyncRef.current >= REVIEWS_PER_AUTO_SYNC) {
          reviewsSinceSyncRef.current = 0;
          void executeSync();
        }
      }
    },
    [executeSync, metaRef],
  );

  const getCurrentWatermarks = useCallback((): Record<string, number> => {
    return buildWatermarks(metaRef.current.deviceId, metaRef.current.seq, cursorRef.current);
  }, [metaRef]);

  const clearCollectionBinding = useCallback((): DeviceMeta => {
    const current = metaRef.current;
    if (current.collectionId === undefined) return current;
    const { collectionId: _dropped, ...rest } = current;
    void _dropped;
    onStateMutated(rest);
    return rest;
  }, [metaRef, onStateMutated]);

  const connectGoogleDrive = useCallback(async (): Promise<void> => {
    const auth = await platform.getGoogleAuth();
    await auth.signIn();
  }, [platform]);

  const connectLocalFolder = useCallback(async (): Promise<boolean> => {
    const picked = await platform.pickLocalSyncFolder();
    if (!picked) return false;

    localFolderTransportRef.current = picked.transport;
    const nextConfig: SyncConfig = {
      provider: 'local_folder',
      connectedAt: Date.now(),
      localFolderName: picked.name,
    };
    configRef.current = nextConfig;

    // Always reset sync cursor & collection binding when picking a folder so switching
    // folders or providers never causes a stale `collection_mismatch`; SyncEngine safely
    // skips own already-pushed seqs if re-picking the same folder.
    const { createInitialSyncCursor } = await import('@flash/core/sync');
    const freshCursor = createInitialSyncCursor();
    cursorRef.current = freshCursor;
    const clearedMeta = clearCollectionBinding();

    await enqueuePersist(async () => {
      await platform.storage.setSyncConfig(nextConfig);
      await platform.storage.setSyncCursor(freshCursor);
      await platform.storage.setDeviceMeta(clearedMeta);
    });

    setSyncState((prev) => ({
      provider: 'local_folder',
      status: 'idle',
      isOnline: prev.isOnline,
      readOnly: false,
      localFolderName: picked.name,
      pendingCount: Math.max(0, metaRef.current.seq - freshCursor.lastPushedSeq),
      lastPulledCount: 0,
      lastPushedCount: 0,
    }));

    await executeSync();
    return true;
  }, [clearCollectionBinding, enqueuePersist, executeSync, metaRef, platform]);

  const reconnectLocalFolder = useCallback(async (): Promise<boolean> => {
    const restored = await platform.restoreLocalSyncFolder({ requestPermission: true });
    if (!restored) return false;
    localFolderTransportRef.current = restored.transport;
    await executeSync();
    return true;
  }, [executeSync, platform]);

  const disconnectSync = useCallback(async (): Promise<void> => {
    const prevProvider = configRef.current.provider;
    if (prevProvider === 'google_drive') {
      const auth = await platform.getGoogleAuth();
      await auth.signOut();
    } else if (prevProvider === 'local_folder') {
      localFolderTransportRef.current = null;
      await platform.disconnectLocalSyncFolder();
    }

    const nextConfig: SyncConfig = { provider: 'none' };
    configRef.current = nextConfig;
    const { createInitialSyncCursor } = await import('@flash/core/sync');
    const freshCursor = createInitialSyncCursor();
    cursorRef.current = freshCursor;
    const clearedMeta = clearCollectionBinding();

    await enqueuePersist(async () => {
      await platform.storage.setSyncConfig(nextConfig);
      await platform.storage.setSyncCursor(freshCursor);
      await platform.storage.setDeviceMeta(clearedMeta);
    });

    setSyncState({
      provider: 'none',
      status: 'disconnected',
      isOnline: isNavigatorOnline(),
      readOnly: false,
      pendingCount: 0,
      lastPulledCount: 0,
      lastPushedCount: 0,
    });
  }, [clearCollectionBinding, enqueuePersist, platform]);

  const resetSyncState = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    workerHydratedRef.current = false;
    workerTrackingLocalRef.current = false;
    pendingWorkerLocalEventsRef.current = [];
    cursorRef.current = undefined;
    reviewsSinceSyncRef.current = 0;
    lastLocalSnapshotCountRef.current = 0;
    localFolderTransportRef.current = null;

    const resetProvider: SyncProviderKind = platform.hasDeviceSlug ? 'dev_channel' : 'none';
    configRef.current = { provider: resetProvider };
    setSyncState({
      provider: resetProvider,
      status: resetProvider === 'none' ? 'disconnected' : 'idle',
      isOnline: isNavigatorOnline(),
      readOnly: false,
      pendingCount: 0,
      lastPulledCount: 0,
      lastPushedCount: 0,
    });
  }, [platform.hasDeviceSlug]);

  return {
    syncState,
    syncNow,
    connectGoogleDrive,
    connectLocalFolder,
    reconnectLocalFolder,
    disconnectSync,
    notifyLocalEvents,
    getCurrentWatermarks,
    resetSyncState,
  };
}
