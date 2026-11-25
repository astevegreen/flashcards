import type { FlashEvent, SyncCursorState } from '@flash/core';
import type { DeviceMeta, SyncConfig, SyncProviderKind } from '@flash/platform';
import type { SyncController, SyncUiState, SyncUiStatus } from './useSyncController.ts';

/**
 * The part of sync that has to exist at first paint (P1). The sync controller itself
 * (`useSyncController`) runs in the lazy, always-mounted `SyncRuntime`, so it stays out of the
 * initial chunk. Until it attaches, this shell answers for it: local-event notices are queued and
 * replayed in order, watermarks come from the boot cursor (the controller's own cursor until its
 * first sync), and actions wait for it.
 */
export type SyncActions = Omit<SyncController, 'syncState'>;

export interface SyncShell extends SyncActions {
  /** Called by `SyncRuntime` on every render, with that render's controller. */
  attach: (controller: SyncActions) => void;
}

export function isNavigatorOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export function isNetworkSyncProvider(provider: SyncProviderKind): boolean {
  return (
    provider === 'google_drive' ||
    provider === 'dropbox' ||
    provider === 'onedrive' ||
    provider === 'dev_channel'
  );
}

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

/** The sync status shown at first paint, before the controller loads. */
export function initialSyncUiState(
  provider: SyncProviderKind,
  meta: DeviceMeta,
  config?: SyncConfig,
  cursor?: SyncCursorState,
  oauthError?: string,
): SyncUiState {
  const online = isNavigatorOnline();
  const status: SyncUiStatus = oauthError
    ? 'error'
    : provider === 'none'
      ? 'disconnected'
      : !online && isNetworkSyncProvider(provider)
        ? 'offline'
        : cursor?.lastSyncedAt
          ? 'synced'
          : 'idle';
  return {
    provider,
    status,
    isOnline: online,
    readOnly: false,
    ...(cursor?.lastSyncedAt !== undefined ? { lastSyncedAt: cursor.lastSyncedAt } : {}),
    ...(config?.localFolderName !== undefined ? { localFolderName: config.localFolderName } : {}),
    pendingCount: Math.max(0, meta.seq - (cursor?.lastPushedSeq ?? 0)),
    ...(oauthError !== undefined ? { errorMessage: oauthError } : {}),
    lastPulledCount: 0,
    lastPushedCount: 0,
  };
}

export function createSyncShell(bootWatermarks: () => Record<string, number>): SyncShell {
  let controller: SyncActions | undefined;
  let queued: Array<[readonly FlashEvent[], number | undefined]> = [];
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  // Always the latest controller: its callbacks change as its dependencies do.
  const later =
    <A extends unknown[], R>(pick: (c: SyncActions) => (...args: A) => R) =>
    (...args: A) =>
      // `then` flattens R when R is a promise; TS can't see that through the generic.
      ready.then(() => pick(controller as SyncActions)(...args)) as Promise<Awaited<R>>;
  return {
    attach(next) {
      controller = next;
      if (queued.length > 0) {
        const replay = queued;
        queued = [];
        for (const [events, reviewCount] of replay) next.notifyLocalEvents(events, reviewCount);
      }
      markReady();
    },
    notifyLocalEvents(events, reviewCount) {
      if (controller) controller.notifyLocalEvents(events, reviewCount);
      else queued.push([events, reviewCount]);
    },
    getCurrentWatermarks: () => (controller ? controller.getCurrentWatermarks() : bootWatermarks()),
    syncNow: later((c) => c.syncNow),
    flushPendingSync: later((c) => c.flushPendingSync),
    connectGoogleDrive: later((c) => c.connectGoogleDrive),
    connectDropbox: later((c) => c.connectDropbox),
    connectOneDrive: later((c) => c.connectOneDrive),
    connectLocalFolder: later((c) => c.connectLocalFolder),
    reconnectLocalFolder: later((c) => c.reconnectLocalFolder),
    connectICloud: later((c) => c.connectICloud),
    disconnectSync: later((c) => c.disconnectSync),
    resolveCollectionChoice: later((c) => c.resolveCollectionChoice),
    resetSyncState: later((c) => c.resetSyncState),
  };
}
