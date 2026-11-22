import type { SyncUiState } from './useSyncController.ts';

/**
 * When this launch's leech backfill may run. With no sync provider it runs at once. With one it
 * waits for a sync that COMPLETED DURING THIS LAUNCH: the initial `synced` status that a device
 * shows from its stored sync cursor says nothing about what other devices wrote since, and a plan
 * made before pulling could re-add a `leech` tag another device already added and the user removed.
 * A read-only (upgrade required) device never writes.
 */
export function isLeechBackfillReady(
  sync: Pick<SyncUiState, 'provider' | 'status' | 'readOnly' | 'lastSyncedAt'>,
  launchedAtMs: number,
): boolean {
  if (sync.readOnly) return false;
  if (sync.provider === 'none') return true;
  return sync.status === 'synced' && (sync.lastSyncedAt ?? 0) >= launchedAtMs;
}
