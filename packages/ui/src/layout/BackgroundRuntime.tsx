import { useEffect, useState } from 'react';
import { AutoBackupRuntime } from '../backups/AutoBackupRuntime.tsx';
import { ReminderRuntime, type ReminderRuntimeProps } from '../reminders/ReminderRuntime.tsx';
import { useApp } from '../state/AppContext.tsx';
import { listenForRebuild } from '../state/rebuildChannel.ts';

/**
 * When another tab of this device saved a Check database rebuild, asks before reloading: this tab
 * may hold an unsaved draft. The reload waits for this tab's queued writes to reach storage.
 */
function RebuildListener() {
  const { platform, whenSaved } = useApp();
  const deviceId = platform.deviceId;
  const [rebuilt, setRebuilt] = useState(false);
  const [reloading, setReloading] = useState(false);
  useEffect(() => listenForRebuild(deviceId, () => setRebuilt(true)), [deviceId]);
  if (!rebuilt) return null;
  return (
    <div
      role="alert"
      data-testid="rebuild-reload-prompt"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--accent-soft)] px-4 py-3 text-sm text-[var(--fg)]"
    >
      <span className="min-w-0 flex-1 basis-48 break-words">
        The collection was rebuilt in another tab. Save any open edit, then reload this tab.
      </span>
      <button
        type="button"
        disabled={reloading}
        onClick={() => {
          setReloading(true);
          // A failed write keeps the tab open (the "not saved" alert offers a retry).
          whenSaved().then(
            () => location.reload(),
            () => setReloading(false),
          );
        }}
        className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-semibold text-white disabled:opacity-60"
      >
        Reload now
      </button>
    </div>
  );
}

/**
 * Background work that renders nothing: study reminders, automatic backups and the rebuild
 * listener (lazy, §8).
 */
export function BackgroundRuntime(props: Readonly<ReminderRuntimeProps>) {
  return (
    <>
      <ReminderRuntime {...props} />
      <AutoBackupRuntime />
      <RebuildListener />
    </>
  );
}
