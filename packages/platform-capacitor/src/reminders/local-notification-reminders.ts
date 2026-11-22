import type {
  ReminderPermission,
  ScheduledStudyReminder,
  StudyReminderScheduler,
} from '@flash/platform';

/** Permission states `@capacitor/local-notifications` reports for `display`. */
export type LocalNotificationPermission = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';

/** The slice of `@capacitor/local-notifications` the reminder scheduler uses (injected for tests). */
export interface LocalNotificationsBridge {
  checkPermissions(): Promise<{ display: LocalNotificationPermission }>;
  requestPermissions(): Promise<{ display: LocalNotificationPermission }>;
  schedule(options: {
    notifications: Array<{
      id: number;
      title: string;
      body: string;
      schedule: { at: Date; allowWhileIdle: boolean };
    }>;
  }): Promise<unknown>;
  getPending(): Promise<{ notifications: Array<{ id: number }> }>;
  cancel(options: { notifications: Array<{ id: number }> }): Promise<void>;
}

/**
 * Notification ids reserved for study reminders, so cancelling them never touches any other
 * notification the app may schedule later.
 */
export const STUDY_REMINDER_ID_BASE = 71_300;
export const STUDY_REMINDER_ID_COUNT = 32;

function isReminderId(id: number): boolean {
  return id >= STUDY_REMINDER_ID_BASE && id < STUDY_REMINDER_ID_BASE + STUDY_REMINDER_ID_COUNT;
}

function toPermission(display: LocalNotificationPermission): ReminderPermission {
  if (display === 'granted' || display === 'denied') return display;
  return 'prompt';
}

/**
 * Study reminders as OS local notifications on Android / iOS. They fire while the app is closed;
 * the app reschedules the next days (with fresh due counts) whenever it runs.
 */
export function createLocalNotificationReminderScheduler(
  plugin: LocalNotificationsBridge,
): StudyReminderScheduler {
  const cancelAll = async () => {
    const { notifications } = await plugin.getPending();
    const ids = notifications.filter((n) => isReminderId(n.id)).map((n) => ({ id: n.id }));
    if (ids.length > 0) await plugin.cancel({ notifications: ids });
  };
  return {
    checkPermission: async () => toPermission((await plugin.checkPermissions()).display),
    requestPermission: async () => toPermission((await plugin.requestPermissions()).display),
    cancelAll,
    replaceAll: async (reminders: readonly ScheduledStudyReminder[]) => {
      await cancelAll();
      const notifications = reminders.slice(0, STUDY_REMINDER_ID_COUNT).map((r, i) => ({
        id: STUDY_REMINDER_ID_BASE + i,
        title: r.title,
        body: r.body,
        // Inexact (no SCHEDULE_EXACT_ALARM permission); allowWhileIdle still fires in Doze.
        schedule: { at: new Date(r.atMs), allowWhileIdle: true },
      }));
      if (notifications.length > 0) await plugin.schedule({ notifications });
    },
  };
}
