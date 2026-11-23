import { AutoBackupRuntime } from '../backups/AutoBackupRuntime.tsx';
import { ReminderRuntime, type ReminderRuntimeProps } from '../reminders/ReminderRuntime.tsx';

/** Background work that renders nothing: study reminders and automatic backups (lazy, §8). */
export function BackgroundRuntime(props: Readonly<ReminderRuntimeProps>) {
  return (
    <>
      <ReminderRuntime {...props} />
      <AutoBackupRuntime />
    </>
  );
}
