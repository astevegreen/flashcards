import { useEffect } from 'react';
import { AutoBackupRuntime } from '../backups/AutoBackupRuntime.tsx';
import { ReminderRuntime, type ReminderRuntimeProps } from '../reminders/ReminderRuntime.tsx';
import { useApp } from '../state/AppContext.tsx';
import { listenForRebuild } from '../state/rebuildChannel.ts';

/** Reloads this tab when another tab of this device saved a Check database rebuild. */
function RebuildListener() {
  const { platform } = useApp();
  const deviceId = platform.deviceId;
  useEffect(() => listenForRebuild(deviceId, () => location.reload()), [deviceId]);
  return null;
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
