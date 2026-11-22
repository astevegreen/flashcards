import type { CollectionState } from '../events/replay.ts';
import { buildStudyQueue } from './queue.ts';

/** Phase 13 study reminders: a local time of day, e.g. 19:30. */
export interface ReminderTimeOfDay {
  hour: number;
  minute: number;
}

/** One reminder instant and the UTC offset in effect then (minutes east of UTC). */
export interface ReminderOccurrence {
  atMs: number;
  tzOffsetMinutes: number;
}

export interface PlannedReminder extends ReminderOccurrence {
  /** Cards the study queue would offer at `atMs` (learning + due + new), if nothing is studied. */
  dueCount: number;
}

/** How many daily reminders the native shells schedule ahead (rescheduled whenever the app runs). */
export const REMINDER_PLAN_DAYS = 7;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export function isValidReminderTime(time: ReminderTimeOfDay): boolean {
  return (
    Number.isInteger(time.hour) &&
    Number.isInteger(time.minute) &&
    time.hour >= 0 &&
    time.hour <= 23 &&
    time.minute >= 0 &&
    time.minute <= 59
  );
}

/** UTC instant of `localMs` (a wall-clock time expressed as if it were UTC) under `tzOffsetAt`. */
function localToUtc(localMs: number, tzOffsetAt: (utcMs: number) => number): ReminderOccurrence {
  // Guess with the offset at the naive instant, then re-read the offset at the guess so a
  // daylight-saving change between the two is honoured.
  // A wall-clock time inside a spring-forward gap lands just after it.
  const guess = localMs - tzOffsetAt(localMs) * MINUTE_MS;
  const atMs = localMs - tzOffsetAt(guess) * MINUTE_MS;
  return { atMs, tzOffsetMinutes: tzOffsetAt(atMs) };
}

/**
 * The next `count` occurrences of `time` (local wall clock) strictly after `nowMs`, one per day.
 * `tzOffsetAt(utcMs)` returns the UTC offset in effect at an instant (DST-aware callers pass
 * `(ms) => -new Date(ms).getTimezoneOffset()`); keeping it a parameter keeps core pure and testable.
 */
export function nextReminderOccurrences(
  nowMs: number,
  time: ReminderTimeOfDay,
  count: number,
  tzOffsetAt: (utcMs: number) => number,
): ReminderOccurrence[] {
  if (!isValidReminderTime(time) || count <= 0) return [];
  const localNow = nowMs + tzOffsetAt(nowMs) * MINUTE_MS;
  const localMidnight = Math.floor(localNow / DAY_MS) * DAY_MS;
  const timeOfDayMs = (time.hour * 60 + time.minute) * MINUTE_MS;
  const out: ReminderOccurrence[] = [];
  // Day 0 may already be past; a DST jump can at most push one more day out.
  for (let day = 0; out.length < count && day < count + 2; day++) {
    const occurrence = localToUtc(localMidnight + day * DAY_MS + timeOfDayMs, tzOffsetAt);
    const last = out.at(-1);
    if (occurrence.atMs > nowMs && (!last || occurrence.atMs > last.atMs)) out.push(occurrence);
  }
  return out;
}

/**
 * The due count each reminder would show: what the study queue offers at that instant if the
 * learner studies nothing before then (same schedule, daily limits and sibling burying as Study).
 */
export function planStudyReminders(
  state: CollectionState,
  occurrences: readonly ReminderOccurrence[],
): PlannedReminder[] {
  return occurrences.map((occurrence) => ({
    ...occurrence,
    dueCount: buildStudyQueue(state, {
      nowMs: occurrence.atMs,
      tzOffsetMinutes: occurrence.tzOffsetMinutes,
    }).counts.total,
  }));
}
