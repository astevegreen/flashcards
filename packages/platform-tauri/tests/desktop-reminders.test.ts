import { describe, expect, it } from 'vitest';
import {
  createDesktopReminderScheduler,
  DESKTOP_REMINDER_GRACE_MS,
  DESKTOP_REMINDER_TICK_MS,
  type DesktopNotificationBridge,
  type ReminderClock,
} from '../src/reminders/desktop-reminders.ts';

function fakeClock(start: number) {
  let now = start;
  let callback: (() => void) | null = null;
  let intervals = 0;
  const clock: ReminderClock = {
    now: () => now,
    setInterval: (cb, ms) => {
      expect(ms).toBe(DESKTOP_REMINDER_TICK_MS);
      callback = cb;
      intervals += 1;
      return intervals;
    },
    clearInterval: () => {
      callback = null;
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      callback?.();
    },
    running: () => callback !== null,
  };
}

function fakeBridge(granted: boolean, answer = 'granted') {
  const shown: string[] = [];
  let asked = 0;
  const bridge: DesktopNotificationBridge = {
    isPermissionGranted: async () => granted,
    requestPermission: async () => {
      asked += 1;
      return answer;
    },
    notify: ({ body }) => shown.push(body),
  };
  return { bridge, shown, asked: () => asked };
}

const T0 = Date.UTC(2026, 10, 22, 9, 0);
const MIN = 60_000;

describe('Tauri desktop study reminders', () => {
  it('reports permission and only prompts when not yet granted', async () => {
    const granted = fakeBridge(true);
    const s1 = createDesktopReminderScheduler(granted.bridge, fakeClock(T0).clock);
    expect(await s1.checkPermission()).toBe('granted');
    expect(await s1.requestPermission()).toBe('granted');
    expect(granted.asked()).toBe(0);

    const dismissed = fakeBridge(false, 'default');
    const s2 = createDesktopReminderScheduler(dismissed.bridge, fakeClock(T0).clock);
    expect(await s2.checkPermission()).toBe('prompt');
    expect(await s2.requestPermission()).toBe('prompt');
    const denied = fakeBridge(false, 'denied');
    expect(
      await createDesktopReminderScheduler(denied.bridge, fakeClock(T0).clock).requestPermission(),
    ).toBe('denied');
  });

  it('shows each reminder once when its time comes, then stops ticking', async () => {
    const { bridge, shown } = fakeBridge(true);
    const c = fakeClock(T0);
    const scheduler = createDesktopReminderScheduler(bridge, c.clock);
    await scheduler.replaceAll([
      { atMs: T0 - MIN, title: 't', body: 'past' },
      { atMs: T0 + 5 * MIN, title: 't', body: 'first' },
      { atMs: T0 + 10 * MIN, title: 't', body: 'second' },
    ]);
    c.advance(4 * MIN);
    expect(shown).toEqual([]);
    c.advance(1.5 * MIN);
    expect(shown).toEqual(['first']);
    c.advance(0.5 * MIN);
    expect(shown).toEqual(['first']);
    c.advance(5 * MIN);
    expect(shown).toEqual(['first', 'second']);
    expect(c.running()).toBe(false);
  });

  it('collapses missed reminders after a sleep and skips ones far too late', async () => {
    const { bridge, shown } = fakeBridge(true);
    const c = fakeClock(T0);
    const scheduler = createDesktopReminderScheduler(bridge, c.clock);
    await scheduler.replaceAll([
      { atMs: T0 + MIN, title: 't', body: 'a' },
      { atMs: T0 + 2 * MIN, title: 't', body: 'b' },
      { atMs: T0 + 3 * DESKTOP_REMINDER_GRACE_MS, title: 't', body: 'c' },
    ]);
    c.advance(30 * MIN);
    expect(shown).toEqual(['b']);
    // Woken more than the grace period after "c".
    c.advance(3 * DESKTOP_REMINDER_GRACE_MS + 40 * MIN);
    expect(shown).toEqual(['b']);
  });

  it('cancelAll and replaceAll drop earlier reminders', async () => {
    const { bridge, shown } = fakeBridge(true);
    const c = fakeClock(T0);
    const scheduler = createDesktopReminderScheduler(bridge, c.clock);
    await scheduler.replaceAll([{ atMs: T0 + MIN, title: 't', body: 'old' }]);
    await scheduler.replaceAll([{ atMs: T0 + 2 * MIN, title: 't', body: 'new' }]);
    c.advance(3 * MIN);
    expect(shown).toEqual(['new']);
    await scheduler.replaceAll([{ atMs: T0 + 10 * MIN, title: 't', body: 'x' }]);
    await scheduler.cancelAll();
    expect(c.running()).toBe(false);
    c.advance(20 * MIN);
    expect(shown).toEqual(['new']);
  });
});
