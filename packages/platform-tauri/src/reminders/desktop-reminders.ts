import type {
  ReminderPermission,
  ScheduledStudyReminder,
  StudyReminderScheduler,
} from '@flash/platform';

/** The slice of `@tauri-apps/plugin-notification` the desktop scheduler uses (injected for tests). */
export interface DesktopNotificationBridge {
  isPermissionGranted(): Promise<boolean>;
  /** Resolves `'granted'`, `'denied'` or `'default'` (the user dismissed the prompt). */
  requestPermission(): Promise<string>;
  notify(notification: { title: string; body: string }): void;
}

export interface ReminderClock {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** How often the desktop app checks for a reminder that is due. */
export const DESKTOP_REMINDER_TICK_MS = 30_000;
/** A reminder missed by more than this (the PC was asleep or off) is skipped, not shown late. */
export const DESKTOP_REMINDER_GRACE_MS = 60 * 60_000;

const DEFAULT_CLOCK: ReminderClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

function toPermission(result: string): ReminderPermission {
  if (result === 'granted' || result === 'denied') return result;
  return 'prompt';
}

/**
 * Desktop study reminders. tauri-plugin-notification can show a notification but cannot
 * schedule one on Windows / macOS / Linux, so the app checks the schedule itself: reminders
 * show while the app is running (open, minimized or in the background), not after it quits.
 * A periodic check (not one long timer) keeps working across sleep / resume.
 */
export function createDesktopReminderScheduler(
  bridge: DesktopNotificationBridge,
  clock: ReminderClock = DEFAULT_CLOCK,
): StudyReminderScheduler {
  let pending: ScheduledStudyReminder[] = [];
  let timer: unknown = null;

  const stop = () => {
    if (timer !== null) clock.clearInterval(timer);
    timer = null;
  };

  const tick = () => {
    const now = clock.now();
    const [first, ...rest] = pending.filter((r) => r.atMs <= now);
    if (first === undefined) return;
    pending = pending.filter((r) => r.atMs > now);
    // Several overdue reminders (e.g. after a long sleep) collapse into the latest one.
    const latest = rest.reduce((a, r) => (r.atMs > a.atMs ? r : a), first);
    if (now - latest.atMs <= DESKTOP_REMINDER_GRACE_MS) {
      bridge.notify({ title: latest.title, body: latest.body });
    }
    if (pending.length === 0) stop();
  };

  return {
    checkPermission: async () => ((await bridge.isPermissionGranted()) ? 'granted' : 'prompt'),
    requestPermission: async () => {
      if (await bridge.isPermissionGranted()) return 'granted';
      return toPermission(await bridge.requestPermission());
    },
    replaceAll: (reminders) => {
      stop();
      const now = clock.now();
      pending = reminders
        .filter((r) => r.atMs > now)
        .map((r) => ({ atMs: r.atMs, title: r.title, body: r.body }));
      if (pending.length > 0) timer = clock.setInterval(tick, DESKTOP_REMINDER_TICK_MS);
      return Promise.resolve();
    },
    cancelAll: () => {
      stop();
      pending = [];
      return Promise.resolve();
    },
  };
}
