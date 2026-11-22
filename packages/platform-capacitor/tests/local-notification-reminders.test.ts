import { describe, expect, it } from 'vitest';
import {
  createLocalNotificationReminderScheduler,
  STUDY_REMINDER_ID_BASE,
  STUDY_REMINDER_ID_COUNT,
  type LocalNotificationPermission,
  type LocalNotificationsBridge,
} from '../src/reminders/local-notification-reminders.ts';

function fakePlugin(display: LocalNotificationPermission = 'prompt') {
  let permission = display;
  const pending = new Map<number, { id: number; title: string; at: Date }>();
  const calls: string[] = [];
  // An unrelated notification the app may own.
  pending.set(5, { id: 5, title: 'other', at: new Date(0) });
  const plugin: LocalNotificationsBridge = {
    checkPermissions: async () => ({ display: permission }),
    requestPermissions: async () => {
      calls.push('request');
      permission = 'granted';
      return { display: permission };
    },
    schedule: async ({ notifications }) => {
      for (const n of notifications)
        pending.set(n.id, { id: n.id, title: n.title, at: n.schedule.at });
      return {};
    },
    getPending: async () => ({ notifications: [...pending.values()].map((n) => ({ id: n.id })) }),
    cancel: async ({ notifications }) => {
      for (const n of notifications) pending.delete(n.id);
    },
  };
  return { plugin, pending, calls };
}

describe('Capacitor study reminders (local notifications)', () => {
  it('maps permission states and only requests when asked', async () => {
    const { plugin, calls } = fakePlugin('prompt-with-rationale');
    const scheduler = createLocalNotificationReminderScheduler(plugin);
    expect(await scheduler.checkPermission()).toBe('prompt');
    expect(calls).toEqual([]);
    expect(await scheduler.requestPermission()).toBe('granted');
    expect(calls).toEqual(['request']);
    const denied = createLocalNotificationReminderScheduler(fakePlugin('denied').plugin);
    expect(await denied.checkPermission()).toBe('denied');
  });

  it('replaces only its own reminders and keeps other notifications', async () => {
    const { plugin, pending } = fakePlugin('granted');
    const scheduler = createLocalNotificationReminderScheduler(plugin);
    const at = Date.UTC(2026, 10, 23, 10, 0);
    await scheduler.replaceAll([
      { atMs: at, title: 'Time to study', body: '12 cards are due.' },
      { atMs: at + 86_400_000, title: 'Time to study', body: '3 cards are due.' },
    ]);
    expect([...pending.keys()].sort((a, b) => a - b)).toEqual([
      5,
      STUDY_REMINDER_ID_BASE,
      STUDY_REMINDER_ID_BASE + 1,
    ]);
    expect(pending.get(STUDY_REMINDER_ID_BASE)?.at.getTime()).toBe(at);

    await scheduler.replaceAll([{ atMs: at + 3_600_000, title: 'T', body: 'B' }]);
    expect([...pending.keys()].sort((a, b) => a - b)).toEqual([5, STUDY_REMINDER_ID_BASE]);

    await scheduler.cancelAll();
    expect([...pending.keys()]).toEqual([5]);
  });

  it('caps the number of scheduled reminders to its reserved id range', async () => {
    const { plugin, pending } = fakePlugin('granted');
    const scheduler = createLocalNotificationReminderScheduler(plugin);
    const many = Array.from({ length: STUDY_REMINDER_ID_COUNT + 5 }, (_, i) => ({
      atMs: 1_000 + i,
      title: 't',
      body: 'b',
    }));
    await scheduler.replaceAll(many);
    expect(pending.size).toBe(STUDY_REMINDER_ID_COUNT + 1);
  });
});
