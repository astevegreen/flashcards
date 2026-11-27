import type { CollectionState } from '@flash/core';
import type { DeviceMeta } from '@flash/platform';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { useSyncState } from '../state/syncStateStore.ts';
import { SECURE_KEYS_LOST_KV_KEY } from '../state/secureKeysNotice.ts';
import type { SyncUiState } from '../state/useSyncController.ts';
import type { NavTab } from './AppShell.tsx';

const SECURE_KEYS_LOST_MESSAGE =
  'This device lost the secure key that protected your sign-ins (this can happen after a system update or a restore). Your cards are safe. Please sign in again to resume syncing.';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const BANNER =
  'flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--accent-soft)] px-4 py-2 text-xs text-[var(--fg)]';

/** The weekly backup reminder: for collections no cloud or folder sync keeps (§4.4). */
function backupReminderDue(
  state: CollectionState,
  meta: DeviceMeta | null,
  sync: SyncUiState,
  now: number,
): boolean {
  // Automatic backups stay on the device, so they never hide it.
  if (sync.provider !== 'none' && sync.provider !== 'dev_channel') {
    if (sync.status !== 'reconnect_required') return false;
  }
  if (state.decks.size === 0) return false;
  const dismissedAt = meta?.backupReminderDismissedAt;
  if (dismissedAt !== undefined && now - dismissedAt < SEVEN_DAYS_MS) return false;
  if (meta?.lastBackupAt !== undefined) return now - meta.lastBackupAt > SEVEN_DAYS_MS;
  // Never backed up: shown once the user has recorded at least 5 reviews.
  let reviewCount = 0;
  for (const list of state.reviewsByCard.values()) {
    reviewCount += list.length;
    if (reviewCount >= 5) return true;
  }
  return false;
}

/**
 * The secure-keys-lost notice and the weekly backup reminder, at the top of the main viewport.
 * Both are rare, so AppShell loads this lazily, outside the initial chunk (§8).
 */
export function ShellNotices({ onSelectTab }: Readonly<{ onSelectTab: (tab: NavTab) => void }>) {
  const { platform, state, meta, dismissBackupBanner } = useApp();
  const syncState = useSyncState();
  const storage = platform.storage;

  // The phone apps leave a plain flag when the sign-in secrets were lost (Android: the Keystore
  // key was lost and the secrets dropped; iOS: stored Keychain items are gone). Shown once; re-read
  // when the sync status changes (the loss is usually found by the first sync after launch).
  const [keysLost, setKeysLost] = useState(false);
  const keysDismissedRef = useRef(false);
  useEffect(() => {
    let live = true;
    storage
      .getKv(SECURE_KEYS_LOST_KV_KEY)
      .then((flag) => {
        // Once dismissed in this session, a later sync-status change never brings it back.
        if (live && flag !== undefined && !keysDismissedRef.current) setKeysLost(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [storage, syncState.status]);
  const dismissKeysLost = () => {
    keysDismissedRef.current = true;
    setKeysLost(false);
    storage.deleteKv(SECURE_KEYS_LOST_KV_KEY).catch(() => undefined);
  };

  return (
    <>
      {keysLost && (
        <div role="alert" data-testid="secure-keys-lost-notice" className={BANNER}>
          <span className="min-w-0 flex-1 basis-48 break-words">{SECURE_KEYS_LOST_MESSAGE}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                dismissKeysLost();
                onSelectTab('settings');
              }}
              className="min-h-11 rounded-md bg-[var(--accent)] px-2.5 py-1 font-semibold text-white"
            >
              Sign in again
            </button>
            <button
              type="button"
              data-testid="secure-keys-lost-dismiss"
              onClick={dismissKeysLost}
              className="min-h-11 rounded-md px-2 py-1 text-[var(--muted)] hover:bg-[var(--surface-2)]"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {backupReminderDue(state, meta, syncState, Date.now()) && (
        <div role="status" className={BANNER}>
          <span>Back up your collection regularly as a .flashpkg file.</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectTab('settings')}
              className="rounded-md bg-[var(--accent)] px-2.5 py-1 font-semibold text-white"
            >
              Export Backup
            </button>
            <button
              type="button"
              onClick={() => void dismissBackupBanner()}
              className="rounded-md px-2 py-1 text-[var(--muted)] hover:bg-[var(--surface-2)]"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );
}
