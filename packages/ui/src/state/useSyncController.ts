import {
  getTotalAppliedEventCount,
  type CollectionState,
  type EventFactory,
  type FlashEvent,
  type SyncCursorState,
} from '@flash/core';
import type {
  DeviceMeta,
  PlatformServices,
  ReplayWorkerClient,
  SyncConfig,
  SyncProviderKind,
  SyncTransport,
} from '@flash/platform';
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { buildWatermarks, isNavigatorOnline, isNetworkSyncProvider } from './syncShell.ts';

export { isNetworkSyncProvider } from './syncShell.ts';

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
  /**
   * Set while the synced store holds a different collection from the one an add-device link named.
   * Nothing is bound, pulled or pushed until the user chooses.
   */
  collectionChoice?: { expectedCollectionId: string; remoteCollectionId: string };
}

/**
 * Runs one sync cycle. A cycle whose code can't load (offline before the chunk was cached) or that
 * throws past the runner's own error handling would leave the status on "syncing" for good (C7):
 * it ends as an error the user can retry instead.
 */
export async function runGuardedSyncCycle(
  run: () => Promise<void>,
  setSyncState: Dispatch<SetStateAction<SyncUiState>>,
): Promise<void> {
  try {
    await run();
  } catch {
    setSyncState((prev) =>
      prev.status === 'syncing'
        ? {
            ...prev,
            status: 'error',
            errorMessage: "Sync couldn't run. Check your connection and try again.",
          }
        : prev,
    );
  }
}

export type { CollectionChoice } from './collectionChoice.ts';
import type { CollectionChoice } from './collectionChoice.ts';

export interface SyncController {
  syncState: SyncUiState;
  syncNow: (opts?: { silent?: boolean }) => Promise<void>;
  flushPendingSync: () => void;
  connectGoogleDrive: () => Promise<void>;
  connectDropbox: () => Promise<void>;
  /** OneDrive app folder: a redirect on web; native shells sign in and connect in place. */
  connectOneDrive: () => Promise<void>;
  connectLocalFolder: () => Promise<boolean>;
  reconnectLocalFolder: () => Promise<boolean>;
  connectICloud: () => Promise<void>;
  disconnectSync: () => Promise<void>;
  /**
   * Answers the "different collection" question. `synced` joins the synced collection (this
   * device's own events are pushed into it); `local` stops syncing and keeps this device's cards.
   * Neither deletes an event.
   */
  resolveCollectionChoice: (choice: CollectionChoice) => Promise<void>;
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
  enqueuePersist: (task: () => Promise<void>) => Promise<void>;
  /** When this tab started; sync snapshot writes check the rebuild stamp against it. */
  startedAtMs?: number;
  onStateMutated: (nextMeta?: DeviceMeta) => void;
  onReplaceState: (nextState: CollectionState, nextMeta: DeviceMeta) => void;
  /** Held by AppProvider (seeded by `initialSyncUiState`) so first paint needs no controller. */
  syncState: SyncUiState;
  setSyncState: Dispatch<SetStateAction<SyncUiState>>;
}

const REVIEWS_PER_AUTO_SYNC = 20;
const AUTO_SYNC_INTERVAL_MS = 120_000;
export const IDLE_PUSH_DEBOUNCE_MS = 8_000;
export const FOREGROUND_PULL_COOLDOWN_MS = 15_000;

export function shouldFlushPendingSync(params: {
  provider: SyncProviderKind;
  pendingCount: number;
  isOnline: boolean;
}): boolean {
  if (params.provider === 'none') return false;
  if (params.pendingCount <= 0) return false;
  if (isNetworkSyncProvider(params.provider) && !params.isOnline) return false;
  return true;
}

export function shouldTriggerForegroundPull(params: {
  provider: SyncProviderKind;
  visibilityState: DocumentVisibilityState;
  isOnline: boolean;
  nowMs: number;
  lastSyncAtMs: number;
  cooldownMs?: number;
  inFlight: boolean;
}): boolean {
  if (params.provider === 'none') return false;
  if (params.visibilityState !== 'visible') return false;
  if (params.inFlight) return false;
  if (isNetworkSyncProvider(params.provider) && !params.isOnline) return false;
  const cooldown = params.cooldownMs ?? FOREGROUND_PULL_COOLDOWN_MS;
  if (params.nowMs - params.lastSyncAtMs < cooldown) return false;
  return true;
}

export function useSyncController({
  platform,
  stateRef,
  metaRef,
  factoryRef,
  initialSyncConfig,
  initialSyncCursor,
  enqueuePersist,
  startedAtMs,
  onStateMutated,
  onReplaceState,
  syncState,
  setSyncState,
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
  const idlePushTimerRef = useRef<number | null>(null);
  const lastSyncCompletedAtRef = useRef<number>(initialSyncCursor?.lastSyncedAt ?? 0);
  const collectionChoiceEpochRef = useRef<number>(0);

  const clearIdlePushTimer = useCallback(() => {
    if (idlePushTimerRef.current !== null) {
      window.clearTimeout(idlePushTimerRef.current);
      idlePushTimerRef.current = null;
    }
  }, []);

  // Clean up Web Worker and timers on unmount
  useEffect(() => {
    return () => {
      clearIdlePushTimer();
      workerRef.current?.terminate();
      workerRef.current = null;
      workerHydratedRef.current = false;
      workerTrackingLocalRef.current = false;
    };
  }, [clearIdlePushTimer]);

  const makeRunnerCtx = useCallback(
    () => ({
      platform,
      stateRef,
      metaRef,
      factoryRef,
      configRef,
      cursorRef,
      localFolderTransportRef,
      workerRef,
      workerHydratedRef,
      workerTrackingLocalRef,
      pendingWorkerLocalEventsRef,
      reviewsSinceSyncRef,
      lastLocalSnapshotCountRef,
      lastSyncCompletedAtRef,
      collectionChoiceEpochRef,
      enqueuePersist,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      onStateMutated,
      onReplaceState,
      setSyncState,
    }),
    [
      enqueuePersist,
      factoryRef,
      metaRef,
      onReplaceState,
      onStateMutated,
      platform,
      setSyncState,
      startedAtMs,
      stateRef,
    ],
  );

  const executeSync = useCallback(async (): Promise<void> => {
    clearIdlePushTimer();
    const provider = configRef.current.provider;
    if (provider === 'none') return;

    const online = isNavigatorOnline();
    if (!online && isNetworkSyncProvider(provider)) {
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
      await runGuardedSyncCycle(async () => {
        const { runSyncCycle } = await import('./syncRunner.ts');
        await runSyncCycle(makeRunnerCtx(), provider);
      }, setSyncState);
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void executeSync();
      }
    }
  }, [clearIdlePushTimer, makeRunnerCtx, metaRef, setSyncState]);

  const syncNow = useCallback(async (): Promise<void> => {
    await executeSync();
  }, [executeSync]);

  const flushPendingSync = useCallback(() => {
    clearIdlePushTimer();
    const provider = configRef.current.provider;
    const pendingCount = Math.max(0, metaRef.current.seq - (cursorRef.current?.lastPushedSeq ?? 0));
    if (
      shouldFlushPendingSync({
        provider,
        pendingCount,
        isOnline: isNavigatorOnline(),
      })
    ) {
      void executeSync();
    }
  }, [clearIdlePushTimer, executeSync, metaRef]);

  // Trigger 1: App open (after first paint) for connected cloud / local-folder providers
  useEffect(() => {
    const provider = configRef.current.provider;
    if (
      provider === 'google_drive' ||
      provider === 'dropbox' ||
      provider === 'onedrive' ||
      provider === 'local_folder' ||
      provider === 'icloud'
    ) {
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
        status: isNetworkSyncProvider(prev.provider) ? 'offline' : prev.status,
      }));
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [executeSync, setSyncState]);

  // Trigger 3: Backgrounding push + throttled foreground pull
  useEffect(() => {
    const pullIfForegroundReady = () => {
      if (
        shouldTriggerForegroundPull({
          provider: configRef.current.provider,
          visibilityState: document.visibilityState,
          isOnline: isNavigatorOnline(),
          nowMs: Date.now(),
          lastSyncAtMs: lastSyncCompletedAtRef.current,
          cooldownMs: FOREGROUND_PULL_COOLDOWN_MS,
          inFlight: inFlightRef.current,
        })
      ) {
        void executeSync();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingSync();
      } else if (document.visibilityState === 'visible') {
        pullIfForegroundReady();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flushPendingSync);
    window.addEventListener('focus', pullIfForegroundReady);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushPendingSync);
      window.removeEventListener('focus', pullIfForegroundReady);
    };
  }, [executeSync, flushPendingSync]);

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

  // Trigger 4a: Track local mutations, auto-sync every 20 reviews, and schedule idle-debounce push
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

      const provider = configRef.current.provider;
      if (provider === 'none' || events.length === 0) return;

      if (reviewCount > 0) {
        reviewsSinceSyncRef.current += reviewCount;
        if (reviewsSinceSyncRef.current >= REVIEWS_PER_AUTO_SYNC) {
          reviewsSinceSyncRef.current = 0;
          clearIdlePushTimer();
          void executeSync();
          return;
        }
      }

      if (
        shouldFlushPendingSync({
          provider,
          pendingCount,
          isOnline: isNavigatorOnline(),
        })
      ) {
        clearIdlePushTimer();
        idlePushTimerRef.current = window.setTimeout(() => {
          idlePushTimerRef.current = null;
          flushPendingSync();
        }, IDLE_PUSH_DEBOUNCE_MS);
      }
    },
    [clearIdlePushTimer, executeSync, flushPendingSync, metaRef, setSyncState],
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
    // Normally a redirect (returns null). With the token helper down or unconfigured, GIS
    // renews access in a popup and returns a session right here (§4.3 tap-to-renew).
    const session = await auth.signIn({ intent: 'sync' });
    if (!session) return;
    const { activateCloudProvider } = await import('./syncRunner.ts');
    await activateCloudProvider(makeRunnerCtx(), 'google_drive', clearCollectionBinding);
    await executeSync();
  }, [clearCollectionBinding, executeSync, makeRunnerCtx, platform]);

  const connectDropbox = useCallback(async (): Promise<void> => {
    if (!platform.getDropboxAuth) {
      throw new Error('Dropbox sync is not available in this build.');
    }
    const auth = await platform.getDropboxAuth();
    // Web redirects away (null); native shells return the session right here.
    const session = await auth.signIn({ intent: 'sync' });
    if (!session) return;
    const { activateCloudProvider } = await import('./syncRunner.ts');
    await activateCloudProvider(makeRunnerCtx(), 'dropbox', clearCollectionBinding);
    await executeSync();
  }, [clearCollectionBinding, executeSync, makeRunnerCtx, platform]);

  const connectOneDrive = useCallback(async (): Promise<void> => {
    if (!platform.getOneDriveAuth) {
      throw new Error('OneDrive sync is not available in this build.');
    }
    const auth = await platform.getOneDriveAuth();
    // Web redirects away (null); native shells return the session right here.
    const session = await auth.signIn({ intent: 'sync' });
    if (!session) return;
    const { activateCloudProvider } = await import('./syncRunner.ts');
    await activateCloudProvider(makeRunnerCtx(), 'onedrive', clearCollectionBinding);
    await executeSync();
  }, [clearCollectionBinding, executeSync, makeRunnerCtx, platform]);

  const connectLocalFolder = useCallback(async (): Promise<boolean> => {
    const { connectLocalFolderSync } = await import('./syncRunner.ts');
    const ok = await connectLocalFolderSync(makeRunnerCtx(), clearCollectionBinding);
    if (!ok) return false;
    await executeSync();
    return true;
  }, [clearCollectionBinding, executeSync, makeRunnerCtx]);

  const reconnectLocalFolder = useCallback(async (): Promise<boolean> => {
    const restored = await platform.restoreLocalSyncFolder({ requestPermission: true });
    if (!restored) return false;
    localFolderTransportRef.current = restored.transport;
    await executeSync();
    return true;
  }, [executeSync, platform]);

  const connectICloud = useCallback(async (): Promise<void> => {
    if (!platform.createICloudTransport) {
      throw new Error('iCloud Drive sync is only available in the iPhone, iPad and Mac apps.');
    }
    // Fails with a clear message when the user is signed out of iCloud or iCloud Drive is off.
    await platform.createICloudTransport();
    const { activateCloudProvider } = await import('./syncRunner.ts');
    await activateCloudProvider(makeRunnerCtx(), 'icloud', clearCollectionBinding);
    await executeSync();
  }, [clearCollectionBinding, executeSync, makeRunnerCtx, platform]);

  const disconnectSync = useCallback(async (): Promise<void> => {
    clearIdlePushTimer();
    lastSyncCompletedAtRef.current = 0;
    const { disconnectActiveSync } = await import('./syncRunner.ts');
    await disconnectActiveSync(makeRunnerCtx(), clearCollectionBinding);
  }, [clearCollectionBinding, clearIdlePushTimer, makeRunnerCtx]);

  const resolveCollectionChoice = useCallback(
    async (choice: CollectionChoice): Promise<void> => {
      const [{ clearAddDeviceExpectation }, { answerCollectionChoice }] = await Promise.all([
        import('../sync/addDeviceExpectation.ts'),
        import('./collectionChoice.ts'),
      ]);
      await answerCollectionChoice({
        choice,
        latch: () => {
          collectionChoiceEpochRef.current += 1;
        },
        disconnect: disconnectSync,
        clearLink: () => clearAddDeviceExpectation(platform.storage),
        sync: executeSync,
        setSyncState,
      });
    },
    [disconnectSync, executeSync, platform.storage, setSyncState],
  );

  const resetSyncState = useCallback(() => {
    clearIdlePushTimer();
    lastSyncCompletedAtRef.current = 0;
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
  }, [clearIdlePushTimer, platform.hasDeviceSlug, setSyncState]);

  return {
    syncState,
    syncNow,
    flushPendingSync,
    connectGoogleDrive,
    connectDropbox,
    connectOneDrive,
    connectLocalFolder,
    reconnectLocalFolder,
    connectICloud,
    disconnectSync,
    resolveCollectionChoice,
    notifyLocalEvents,
    getCurrentWatermarks,
    resetSyncState,
  };
}
