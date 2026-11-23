import { useEffect, useRef } from 'react';
import { useApp } from '../state/AppContext.tsx';

/** The first check waits until the app has settled after launch. */
const AUTO_BACKUP_DELAY_MS = 8_000;

/**
 * Automatic rolling backups: a dated snapshot about once a day the app is used, and the request
 * for persistent storage (§4.4). Renders nothing; the backup code loads only when the first check
 * runs (§8). It never sets `lastBackupAt`, so the reminder still asks users who don't sync to
 * save a copy off the device.
 */
export function AutoBackupRuntime() {
  const { platform, state, meta, syncState } = useApp();
  const latest = useRef({ state, meta, provider: syncState.provider });
  latest.current = { state, meta, provider: syncState.provider };

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      import('./backupRunner.ts')
        .then((m) => {
          if (!live) return;
          stop = m.startAutoBackups({
            platform,
            getState: () => latest.current.state,
            getMeta: () => {
              const current = latest.current.meta;
              if (!current) throw new Error('Device metadata is not ready.');
              return current;
            },
            getSyncProvider: () => latest.current.provider,
          });
        })
        .catch(() => undefined);
    }, AUTO_BACKUP_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      stop?.();
    };
  }, [platform]);

  return null;
}
