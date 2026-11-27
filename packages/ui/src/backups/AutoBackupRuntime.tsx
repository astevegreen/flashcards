import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { useSyncState } from '../state/syncStateStore.ts';

/** The first check waits until the app has settled after launch. */
const AUTO_BACKUP_DELAY_MS = 8_000;
/** Set once the "this browser may clear its storage" notice was shown. */
const PERSIST_NOTICE_KV_KEY = 'persist_notice_shown_v1';

/**
 * Automatic rolling backups: a dated snapshot about once a day the app is used, and the request
 * for persistent storage (§4.4). Renders nothing; the backup code loads only when the first check
 * runs (§8). It never sets `lastBackupAt`, so the reminder still asks users who don't sync to
 * save a copy off the device.
 */
export function AutoBackupRuntime() {
  const { platform, state, meta } = useApp();
  const syncState = useSyncState();
  const latest = useRef({ state, meta, provider: syncState.provider });
  latest.current = { state, meta, provider: syncState.provider };
  const [persistNotice, setPersistNotice] = useState(false);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      import('./backupRunner.ts')
        .then((m) => {
          if (!live) return;
          stop = m.startAutoBackups(
            {
              platform,
              getState: () => latest.current.state,
              getMeta: () => {
                const current = latest.current.meta;
                if (!current) throw new Error('Device metadata is not ready.');
                return current;
              },
              getSyncProvider: () => latest.current.provider,
            },
            (granted) => {
              // With sync on, the sync folder holds the collection if the browser clears it.
              if (granted || !live || latest.current.provider !== 'none') return;
              void platform.storage
                .getKv<boolean>(PERSIST_NOTICE_KV_KEY)
                .then(async (shown) => {
                  if (shown || !live) return;
                  await platform.storage.setKv(PERSIST_NOTICE_KV_KEY, true);
                  setPersistNotice(true);
                })
                .catch(() => undefined);
            },
          );
        })
        .catch(() => undefined);
    }, AUTO_BACKUP_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      stop?.();
    };
  }, [platform]);

  if (!persistNotice) return null;
  return (
    <div
      role="dialog"
      aria-label="Storage notice"
      data-testid="persist-notice"
      className="fixed inset-x-4 bottom-20 z-30 rounded-xl border border-amber-500/40 bg-[var(--surface)] p-3 text-xs shadow-lg md:bottom-4 md:left-auto md:right-4 md:max-w-sm"
    >
      <p>
        This browser may clear the app's data, backups included, when space runs low. Download a
        backup now and then (Settings, Automatic backups), or turn on sync.
      </p>
      <button
        type="button"
        onClick={() => setPersistNotice(false)}
        className="mt-2 rounded-lg border border-[var(--border)] px-2.5 py-1 font-semibold hover:bg-[var(--surface-2)]"
      >
        Got it
      </button>
    </div>
  );
}
