import type { SyncUiState } from '../state/useSyncController.ts';

/** Label and colour of the sync badge at the bottom of the sidebar. */
export function getSidebarBadge(syncState: SyncUiState): { label: string; tone: string } {
  // A pending "which collection?" question is answered in Settings; syncing again only asks again.
  if (syncState.collectionChoice) {
    return { label: 'Choose', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
  }
  if (
    !syncState.isOnline &&
    syncState.provider !== 'local_folder' &&
    syncState.provider !== 'icloud'
  ) {
    return { label: 'Offline', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
  }
  switch (syncState.status) {
    case 'syncing':
      return { label: 'Syncing…', tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' };
    case 'synced':
      return { label: 'Synced', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' };
    case 'offline':
      return { label: 'Offline', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
    case 'reconnect_required':
      return { label: 'Reconnect', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
    case 'upgrade_required':
      return { label: 'Read-only', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
    case 'error':
      return { label: 'Sync Error', tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' };
    case 'idle':
      return { label: 'Sync', tone: 'bg-[var(--surface-2)] text-[var(--muted)]' };
    case 'disconnected':
    default:
      return { label: 'Local', tone: 'bg-[var(--surface-2)] text-[var(--muted)]' };
  }
}

/**
 * Whether a tap on the badge opens Settings instead of syncing: nothing to sync with, a state only
 * Settings can fix, or a collection choice waiting there (syncing again would only ask again).
 */
export function sidebarBadgeOpensSettings(syncState: SyncUiState): boolean {
  return (
    syncState.provider === 'none' ||
    syncState.collectionChoice !== undefined ||
    syncState.status === 'reconnect_required' ||
    syncState.status === 'upgrade_required' ||
    syncState.status === 'error'
  );
}

export function sidebarBadgeTitle(syncState: SyncUiState): string {
  if (syncState.provider === 'none') return 'Configure sync in Settings';
  if (syncState.collectionChoice) return 'Choose a collection in Settings';
  return 'Sync now';
}
