import {
  buildSampleDeckEvents,
  createEventFactory,
  createHlcState,
  replayAllEvents,
  SAMPLE_SEED_EPOCH_MS,
} from '@flash/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MISSING_MEDIA_RETRY_MS, missingMediaRetryDelay } from '../src/components/MediaImage.tsx';
import { createQuietTimer } from '../src/reminders/quietTimer.ts';
import type { StudyReminderConfig } from '../src/reminders/reminderConfig.ts';
import { BADGE_CHANGE_DEBOUNCE_MS, webBadgeCount } from '../src/reminders/ReminderRuntime.tsx';

afterEach(() => {
  vi.useRealTimers();
});

describe('reminder badge refresh (P9)', () => {
  it('rebuilds once after a burst of ratings, when the collection has been quiet for 2 s', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const timer = createQuietTimer(run, BADGE_CHANGE_DEBOUNCE_MS);
    for (let i = 0; i < 10; i++) {
      timer.trigger();
      vi.advanceTimersByTime(500);
    }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BADGE_CHANGE_DEBOUNCE_MS - 500);
    expect(run).toHaveBeenCalledTimes(1);
    timer.trigger();
    timer.cancel();
    vi.advanceTimersByTime(BADGE_CHANGE_DEBOUNCE_MS * 2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('counts due cards only once the reminder time has passed', () => {
    const factory = createEventFactory('dev', 0, createHlcState('dev', SAMPLE_SEED_EPOCH_MS));
    const state = replayAllEvents(buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS));
    const config = (hour: number, enabled = true) =>
      ({ enabled, hour, minute: 0 }) as StudyReminderConfig;
    const noon = new Date(SAMPLE_SEED_EPOCH_MS + 86_400_000);
    noon.setHours(12, 0, 0, 0);
    expect(webBadgeCount(config(9), state, noon.getTime())).toBeGreaterThan(0);
    expect(webBadgeCount(config(18), state, noon.getTime())).toBe(0);
    expect(webBadgeCount(config(9, false), state, noon.getTime())).toBe(0);
  });
});

describe('missing image retry (P9)', () => {
  const hash = 'a'.repeat(64);
  it('reads a new hash at once, and a missing one again only after 5 s', () => {
    expect(missingMediaRetryDelay(null, hash, 1000)).toBe(0);
    expect(missingMediaRetryDelay({ hash: 'b'.repeat(64), atMs: 1000 }, hash, 1000)).toBe(0);
    expect(missingMediaRetryDelay({ hash, atMs: 1000 }, hash, 1000)).toBe(MISSING_MEDIA_RETRY_MS);
    expect(missingMediaRetryDelay({ hash, atMs: 1000 }, hash, 4000)).toBe(
      MISSING_MEDIA_RETRY_MS - 3000,
    );
    expect(missingMediaRetryDelay({ hash, atMs: 1000 }, hash, 1000 + MISSING_MEDIA_RETRY_MS)).toBe(
      0,
    );
  });
});
