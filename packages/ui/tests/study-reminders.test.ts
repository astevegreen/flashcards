import {
  buildSampleDeckEvents,
  createEventFactory,
  createHlcState,
  replayAllEvents,
  SAMPLE_SEED_EPOCH_MS,
  type CollectionState,
} from '@flash/core';
import type {
  ReminderPermission,
  ScheduledStudyReminder,
  StudyReminderScheduler,
} from '@flash/platform';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REMINDER_CONFIG } from '../src/reminders/reminderConfig.ts';
import {
  reminderSettingDescription,
  rescheduleNativeReminders,
  toggleStudyReminders,
  type ReminderPlatform,
} from '../src/reminders/reminderScheduling.ts';

const KST = 540;
/** 2026-03-10 03:00 UTC = 12:00 KST, before the default 19:00 reminder. */
const NOW = Date.UTC(2026, 2, 10, 3, 0, 0);

interface FakeScheduler {
  scheduler: StudyReminderScheduler;
  calls: string[];
  scheduled: ScheduledStudyReminder[] | null;
}

function fakeScheduler(permission: ReminderPermission, afterRequest = permission): FakeScheduler {
  const fake: FakeScheduler = {
    calls: [],
    scheduled: null,
    scheduler: {
      checkPermission: async () => {
        fake.calls.push('checkPermission');
        return permission;
      },
      requestPermission: async () => {
        fake.calls.push('requestPermission');
        return afterRequest;
      },
      replaceAll: async (reminders) => {
        fake.calls.push('replaceAll');
        fake.scheduled = [...reminders];
      },
      cancelAll: async () => {
        fake.calls.push('cancelAll');
        fake.scheduled = [];
      },
    },
  };
  return fake;
}

function nativePlatform(fake: FakeScheduler, loads: { count: number } = { count: 0 }) {
  const platform: ReminderPlatform = {
    studyReminderDelivery: 'os-scheduled',
    getStudyReminderScheduler: async () => {
      loads.count += 1;
      return fake.scheduler;
    },
  };
  return platform;
}

function sampleState(): CollectionState {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', SAMPLE_SEED_EPOCH_MS));
  return replayAllEvents(buildSampleDeckEvents(factory));
}

describe('study reminders: permission only when turned on (Phase 13)', () => {
  it('defaults to off', () => {
    expect(DEFAULT_REMINDER_CONFIG.enabled).toBe(false);
  });

  it('asks for permission when the user turns reminders on, and saves them on', async () => {
    const fake = fakeScheduler('prompt', 'granted');
    const outcome = await toggleStudyReminders(nativePlatform(fake), DEFAULT_REMINDER_CONFIG, true);
    expect(outcome).toEqual({
      kind: 'saved',
      config: { ...DEFAULT_REMINDER_CONFIG, enabled: true },
    });
    expect(fake.calls).toEqual(['requestPermission']);
  });

  it('keeps reminders off when the OS refuses permission', async () => {
    const fake = fakeScheduler('prompt', 'denied');
    const outcome = await toggleStudyReminders(nativePlatform(fake), DEFAULT_REMINDER_CONFIG, true);
    expect(outcome).toEqual({ kind: 'denied' });
  });

  it('never asks (or loads the scheduler) when the user turns reminders off', async () => {
    const fake = fakeScheduler('granted');
    const loads = { count: 0 };
    const on = { ...DEFAULT_REMINDER_CONFIG, enabled: true };
    const outcome = await toggleStudyReminders(nativePlatform(fake, loads), on, false);
    expect(outcome).toEqual({ kind: 'saved', config: { ...on, enabled: false } });
    expect(fake.calls).toEqual([]);
    expect(loads.count).toBe(0);
  });

  it('turns on without any permission request in the PWA (badge only)', async () => {
    const outcome = await toggleStudyReminders({}, DEFAULT_REMINDER_CONFIG, true);
    expect(outcome).toEqual({
      kind: 'saved',
      config: { ...DEFAULT_REMINDER_CONFIG, enabled: true },
    });
  });
});

describe('study reminders: native rescheduling never prompts', () => {
  const on = { ...DEFAULT_REMINDER_CONFIG, enabled: true };
  const kst = () => KST;

  it('schedules the next days with the due count once permission is granted', async () => {
    const fake = fakeScheduler('granted');
    await rescheduleNativeReminders(nativePlatform(fake), on, sampleState(), NOW, kst);
    expect(fake.calls).toEqual(['checkPermission', 'replaceAll']);
    const scheduled = fake.scheduled ?? [];
    expect(scheduled.length).toBeGreaterThan(0);
    // Today 19:00 KST = 10:00 UTC, the first reminder after NOW.
    expect(scheduled[0]?.atMs).toBe(Date.UTC(2026, 2, 10, 10, 0, 0));
    expect(scheduled[0]?.body).toMatch(/^\d+ cards? (is|are) due\.$/);
    for (const r of scheduled) expect(r.atMs).toBeGreaterThan(NOW);
  });

  it('cancels everything when reminders are off, without checking or asking', async () => {
    const fake = fakeScheduler('granted');
    await rescheduleNativeReminders(nativePlatform(fake), DEFAULT_REMINDER_CONFIG, sampleState());
    expect(fake.calls).toEqual(['cancelAll']);
  });

  it.each<ReminderPermission>(['prompt', 'denied'])(
    'cancels everything when permission is %s, and does not ask',
    async (permission) => {
      const fake = fakeScheduler(permission, 'granted');
      await rescheduleNativeReminders(nativePlatform(fake), on, sampleState(), NOW, kst);
      expect(fake.calls).toEqual(['checkPermission', 'cancelAll']);
    },
  );

  it('does nothing in the PWA', async () => {
    await expect(
      rescheduleNativeReminders({}, on, sampleState(), NOW, kst),
    ).resolves.toBeUndefined();
  });
});

describe('study reminders: Settings copy matches how each platform delivers them', () => {
  it('tells desktop users reminders only show while the app is open', () => {
    const fake = fakeScheduler('granted');
    const desktop: ReminderPlatform = {
      studyReminderDelivery: 'while-app-runs',
      getStudyReminderScheduler: async () => fake.scheduler,
    };
    expect(reminderSettingDescription(desktop)).toMatch(/only while the app is open/);
    expect(reminderSettingDescription(nativePlatform(fake))).not.toMatch(/while the app is open/);
    expect(reminderSettingDescription({})).toMatch(/Study tab shows how many cards are due/);
  });
});
