import {
  nextReminderOccurrences,
  planStudyReminders,
  REMINDER_PLAN_DAYS,
  type CollectionState,
} from '@flash/core';
import type { PlatformServices } from '@flash/platform';
import { reminderNotificationText, type StudyReminderConfig } from './reminderConfig.ts';

/** The platform slice the study reminder logic needs (a fake in unit tests). */
export type ReminderPlatform = Pick<
  PlatformServices,
  'getStudyReminderScheduler' | 'studyReminderDelivery'
>;

export const PERMISSION_DENIED_MESSAGE =
  'Notifications are turned off for Flashcards. Allow them in your device settings, then turn reminders on again.';

const localTzOffsetAt = (ms: number) => -new Date(ms).getTimezoneOffset();

/** The Settings explanation under "Daily study reminder" for this platform. */
export function reminderSettingDescription(platform: ReminderPlatform): string {
  if (!platform.getStudyReminderScheduler) {
    return 'After this time, the Study tab shows how many cards are due. Notifications need the mobile or desktop app.';
  }
  if (platform.studyReminderDelivery === 'while-app-runs') {
    return 'A notification at this time with the number of cards due. On desktop it shows only while the app is open (minimized is fine), not after you quit it.';
  }
  return 'A notification at this time with the number of cards due.';
}

export type ReminderToggleOutcome =
  { kind: 'saved'; config: StudyReminderConfig } | { kind: 'denied' };

/**
 * Turning reminders on or off. Notification permission is requested only when the user turns
 * reminders on in a native shell; turning them off, and the PWA, never ask.
 */
export async function toggleStudyReminders(
  platform: ReminderPlatform,
  config: StudyReminderConfig,
  enabled: boolean,
): Promise<ReminderToggleOutcome> {
  if (!enabled) return { kind: 'saved', config: { ...config, enabled: false } };
  if (platform.getStudyReminderScheduler) {
    const scheduler = await platform.getStudyReminderScheduler();
    if ((await scheduler.requestPermission()) !== 'granted') return { kind: 'denied' };
  }
  return { kind: 'saved', config: { ...config, enabled: true } };
}

/**
 * Replaces the native schedule with the next days' reminders (days with nothing due are
 * skipped). Never prompts: it only checks permission, and clears the schedule when reminders are
 * off or permission is missing.
 */
export async function rescheduleNativeReminders(
  platform: ReminderPlatform,
  config: StudyReminderConfig,
  state: CollectionState,
  nowMs: number = Date.now(),
  tzOffsetAt: (utcMs: number) => number = localTzOffsetAt,
): Promise<void> {
  if (!platform.getStudyReminderScheduler) return;
  const scheduler = await platform.getStudyReminderScheduler();
  if (!config.enabled || (await scheduler.checkPermission()) !== 'granted') {
    await scheduler.cancelAll();
    return;
  }
  const occurrences = nextReminderOccurrences(nowMs, config, REMINDER_PLAN_DAYS, tzOffsetAt);
  const reminders = planStudyReminders(state, occurrences)
    .filter((p) => p.dueCount > 0)
    .map((p) => ({ atMs: p.atMs, ...reminderNotificationText(p.dueCount) }));
  await scheduler.replaceAll(reminders);
}
