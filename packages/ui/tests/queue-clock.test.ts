import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyState, type CollectionState, type Deck } from '@flash/core';
import { msUntilNextLocalHour, studyDayKey } from '../src/study/queueClock.ts';

const HOUR = 3_600_000;

function stateWith(globalHour: number, deckHours: Array<number | undefined>): CollectionState {
  const state = createEmptyState();
  state.preferences.day_start_hour = globalHour;
  deckHours.forEach((hour, i) => {
    state.decks.set(`d${i}`, {
      id: `d${i}`,
      settings: hour === undefined ? {} : { day_start_hour: hour },
    } as unknown as Deck);
  });
  return state;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Study queue refresh across the day boundary (C5)', () => {
  // 2026-11-25 is in standard time everywhere this runs; times below are UTC.
  const at = (iso: string) => Date.parse(iso);

  it('studyDayKey changes at the global rollover hour, not before', () => {
    vi.stubEnv('TZ', 'UTC');
    const state = stateWith(4, [undefined]);
    const before = studyDayKey(state, at('2026-11-25T03:59:59Z'));
    expect(studyDayKey(state, at('2026-11-25T03:00:00Z'))).toBe(before);
    expect(studyDayKey(state, at('2026-11-25T04:00:00Z'))).not.toBe(before);
  });

  it('studyDayKey also changes at a deck’s own rollover hour', () => {
    vi.stubEnv('TZ', 'UTC');
    const state = stateWith(4, [undefined, 9]);
    const morning = studyDayKey(state, at('2026-11-25T08:30:00Z'));
    expect(studyDayKey(state, at('2026-11-25T09:00:01Z'))).not.toBe(morning);
    // A "collection default" deck override (-1) adds no hour of its own.
    const defaults = stateWith(4, [-1]);
    expect(studyDayKey(defaults, at('2026-11-25T08:30:00Z'))).toBe(
      studyDayKey(defaults, at('2026-11-25T09:00:01Z')),
    );
  });

  it('msUntilNextLocalHour lands one second past the next hour', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(msUntilNextLocalHour(at('2026-11-25T03:59:59Z'))).toBe(2_000);
    expect(msUntilNextLocalHour(at('2026-11-25T04:00:01Z'))).toBe(HOUR);
    expect(msUntilNextLocalHour(at('2026-11-25T04:30:00Z'))).toBe(HOUR / 2 + 1_000);
  });

  it('uses local hours in a half-hour time zone', () => {
    vi.stubEnv('TZ', 'Asia/Kolkata'); // UTC+5:30
    // 03:59:59Z is 09:29:59 local: the next local hour is half an hour away.
    expect(msUntilNextLocalHour(at('2026-11-25T03:59:59Z'))).toBe(HOUR / 2 + 2_000);
    const state = stateWith(4, [undefined]);
    // The 04:00 local rollover is 22:30Z the day before.
    expect(studyDayKey(state, at('2026-11-24T22:29:59Z'))).not.toBe(
      studyDayKey(state, at('2026-11-24T22:30:00Z')),
    );
  });
});
