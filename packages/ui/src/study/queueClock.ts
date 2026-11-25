import { getStudyDayIndex, resolveDayStartHour, type CollectionState } from '@flash/core';

/**
 * The study day of every rollover hour in use (the global one and each deck's override). It
 * changes exactly when some deck's study day rolls over, including after a time-zone change.
 */
export function studyDayKey(state: CollectionState, nowMs: number): string {
  const tzOffsetMinutes = -new Date(nowMs).getTimezoneOffset();
  const globalHour = state.preferences.day_start_hour;
  const hours = new Set([globalHour]);
  for (const deck of state.decks.values()) {
    hours.add(resolveDayStartHour(deck.settings.day_start_hour, globalHour));
  }
  return [...hours]
    .sort((a, b) => a - b)
    .map((hour) => `${hour}:${getStudyDayIndex(nowMs, tzOffsetMinutes, hour)}`)
    .join(',');
}

/**
 * Milliseconds until one second past the next local hour. Every rollover falls on a local hour
 * (`day_start_hour` is a whole hour), so checking then can't miss one, across DST changes too.
 */
export function msUntilNextLocalHour(nowMs: number): number {
  const next = new Date(nowMs);
  next.setMinutes(60, 1, 0);
  return next.getTime() - nowMs;
}
