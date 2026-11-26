import {
  compareReviewRecords,
  getActiveReviews,
  resolveDeckFsrsConfig,
  type CollectionState,
} from '../../events/replay.ts';
import { applyReviewToSchedule, createInitialSchedule } from '../../fsrs/scheduler.ts';
import type { Card, CardScheduleState, ReviewRecord } from '../../model/types.ts';

/**
 * Review history and scheduling for the `.apkg` export: one Anki `revlog` row per active
 * review (not undone, in replay order `(reviewed_at, hlc, review_id)`), and each card's Anki
 * `type` / `queue` / `due` / `ivl` / `factor` / `reps` / `lapses` / `left` plus the FSRS memory
 * state in `cards.data` (`{"s","d","dr"}`, as Anki 23.10+ stores it), all derived by replaying the
 * card's reviews exactly as `replaySingleCard` does. Practice answers (`PracticeRecorded`) are
 * not reviews and never reach FSRS, so they are not written.
 *
 * Anki conventions used:
 * - revlog `ivl` / `lastIvl`: days when positive, seconds when negative (learning steps);
 *   `lastIvl` is the card's previous revlog `ivl` (0 before its first review);
 * - revlog `type`: 0 learn (card was new or learning), 1 review, 2 relearn;
 * - card `due`: the note position for new cards, epoch seconds for (re)learning cards (queue 1),
 *   a day number relative to the collection's `crt` for review cards (queue 2);
 * - `factor`: 2500 (Anki's default ease) once a card has reached review, else 0. Anki's FSRS
 *   ignores it; it is there for profiles that still use SM-2.
 */

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
/** Anki's default `maxTaken`: answer times are capped at 60 s in the revlog. */
const MAX_ANSWER_MS = 60_000;
const DEFAULT_EASE = 2500;
/** ts-fsrs default steps (1m 10m learning, 10m relearning), the same as the exported dconf. */
const LEARNING_STEPS = 2;
const RELEARNING_STEPS = 1;

export interface AnkiRevlogDraft {
  review: ReviewRecord;
  cid: number;
  ease: number;
  ivl: number;
  lastIvl: number;
  factor: number;
  time: number;
  type: number;
}

export interface AnkiCardScheduling {
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  data: string;
}

/**
 * The exported collection's clock. Anki counts review days from `crt` in the collection's
 * creation offset and rollover hour (rslib `scheduler/timing.rs`), and its importer shifts
 * review dues by `source_today - target_today`. So `crt` is the start of the user's current
 * study day (source today = 0) and a review card's `due` is its study day minus today's, all
 * in one collection-wide offset and hour.
 */
export interface AnkiSchedulingClock {
  nowMs: number;
  /**
   * Minutes east of UTC: the offset at export when the caller knows it, else the latest
   * active review's offset (0 without reviews).
   */
  tzOffsetMinutes: number;
  /** `preferences.day_start_hour`, clamped to 0-23. */
  dayStartHour: number;
  /** The collection's `crt` (Unix seconds): the start of the study day holding `nowMs`. */
  crt: number;
}

export function ankiSchedulingClock(
  state: CollectionState,
  nowMs: number,
  exportTzOffsetMinutes?: number,
): AnkiSchedulingClock {
  const hour = Math.max(0, Math.min(23, Math.floor(state.preferences.day_start_hour)));
  if (exportTzOffsetMinutes !== undefined && Number.isFinite(exportTzOffsetMinutes)) {
    return clockAt(nowMs, Math.round(exportTzOffsetMinutes), hour);
  }
  let latest: ReviewRecord | undefined;
  for (const reviews of state.reviewsByCard.values()) {
    for (const r of reviews) {
      if (state.undoneReviewIds.has(r.review_id)) continue;
      if (!latest || compareReviewRecords(r, latest) > 0) latest = r;
    }
  }
  return clockAt(nowMs, latest?.tz_offset ?? 0, hour);
}

function clockAt(nowMs: number, tz: number, hour: number): AnkiSchedulingClock {
  const day = studyDay(nowMs, tz, hour);
  const crt = (day * MS_PER_DAY + hour * MS_PER_HOUR - tz * MS_PER_MINUTE) / 1000;
  return { nowMs, tzOffsetMinutes: tz, dayStartHour: hour, crt };
}

/** The card's active reviews in replay order. */
export const activeReviews = getActiveReviews;

/** Revlog `ivl` for the state a review left the card in. */
function revlogIvl(after: CardScheduleState, reviewedAt: number): number {
  if (after.state === 2) return Math.max(1, Math.round(after.scheduled_days));
  return -Math.max(1, Math.round((after.due - reviewedAt) / 1000));
}

function revlogType(before: CardScheduleState): number {
  if (before.state === 2) return 1;
  if (before.state === 3) return 2;
  return 0;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** ts-fsrs's FSRS-6 default decay (`FSRS6_DEFAULT_DECAY`, the default `w[20]`). */
const FSRS6_DEFAULT_DECAY = 0.1542;
/** The FSRS-5 decay, for 19-weight parameter sets. */
const FSRS5_DECAY = 0.5;

function decayOf(w: readonly number[] | undefined): number {
  if (!w) return FSRS6_DEFAULT_DECAY;
  const d = w[20];
  return w.length >= 21 && d !== undefined ? d : FSRS5_DECAY;
}

function studyDay(ms: number, tzOffsetMinutes: number, dayStartHour: number): number {
  return Math.floor(
    (ms + tzOffsetMinutes * MS_PER_MINUTE - dayStartHour * MS_PER_HOUR) / MS_PER_DAY,
  );
}

/**
 * Replays one card's active reviews; returns its revlog rows (without ids) and its Anki
 * scheduling. `null` when the card has no active review (it stays new).
 */
export function ankiCardHistory(
  state: CollectionState,
  card: Card,
  cid: number,
  clock: AnkiSchedulingClock,
): { revlog: AnkiRevlogDraft[]; scheduling: AnkiCardScheduling } | null {
  const reviews = activeReviews(state, card.id);
  if (reviews.length === 0) return null;
  let schedule = createInitialSchedule(0);
  let lastIvl = 0;
  const revlog: AnkiRevlogDraft[] = [];
  for (const review of reviews) {
    const config = resolveDeckFsrsConfig(
      state,
      card.deck_id,
      review.reviewed_at,
      review.fsrs_params_version,
    );
    const before = schedule;
    schedule = applyReviewToSchedule(before, review.rating, review.reviewed_at, config).next;
    const ivl = revlogIvl(schedule, review.reviewed_at);
    revlog.push({
      review,
      cid,
      ease: review.rating,
      ivl,
      lastIvl,
      factor: schedule.state === 2 || schedule.state === 3 ? DEFAULT_EASE : 0,
      time: Math.min(MAX_ANSWER_MS, Math.max(0, Math.round(review.duration_ms || 0))),
      type: revlogType(before),
    });
    lastIvl = ivl;
  }
  const last = reviews[reviews.length - 1] as ReviewRecord;
  const config = resolveDeckFsrsConfig(state, card.deck_id, clock.nowMs);
  return {
    revlog,
    scheduling: ankiScheduling(schedule, last, config.request_retention, decayOf(config.w), clock),
  };
}

/**
 * `cards.data` keys as Anki writes them: `s` stability (4 places), `d` difficulty (3), `dr`
 * desired retention (2), `decay` (3, FSRS-6) and `lrt` (last review, Unix seconds).
 */
function ankiScheduling(
  schedule: CardScheduleState,
  last: ReviewRecord,
  dr: number,
  decay: number,
  clock: AnkiSchedulingClock,
): AnkiCardScheduling {
  const data = JSON.stringify({
    s: round(schedule.stability, 4),
    d: round(schedule.difficulty, 3),
    dr: round(dr, 2),
    decay: round(decay, 3),
    lrt: Math.floor(last.reviewed_at / 1000),
  });
  const base = { reps: schedule.reps, lapses: schedule.lapses, data };
  if (schedule.state === 2) {
    const { tzOffsetMinutes: tz, dayStartHour: hour } = clock;
    const due = studyDay(schedule.due, tz, hour) - studyDay(clock.nowMs, tz, hour);
    return {
      ...base,
      type: 2,
      queue: 2,
      due,
      ivl: Math.max(1, Math.round(schedule.scheduled_days)),
      factor: DEFAULT_EASE,
      left: 0,
    };
  }
  const relearning = schedule.state === 3;
  const steps = relearning ? RELEARNING_STEPS : LEARNING_STEPS;
  const remaining = Math.max(1, steps - schedule.learning_steps);
  return {
    ...base,
    type: relearning ? 3 : 1,
    queue: 1,
    due: Math.floor(schedule.due / 1000),
    /**
     * Approximation: a relearning card's `ivl` is its stability rounded, which is its FSRS
     * interval only at 90 % retention. Anki's FSRS recomputes the interval when it graduates.
     */
    ivl: relearning ? Math.max(1, Math.round(schedule.stability)) : 0,
    factor: relearning ? DEFAULT_EASE : 0,
    left: remaining * 1000 + remaining,
  };
}

/**
 * Revlog ids: the review time in ms, nudged up by 1 ms past the previous row on a collision
 * (rows are in replay order across all cards, so the nudge is deterministic).
 */
export function revlogRows(drafts: AnkiRevlogDraft[]): Array<Array<number>> {
  const sorted = [...drafts].sort(
    (a, b) => compareReviewRecords(a.review, b.review) || a.cid - b.cid,
  );
  let prev = -Infinity;
  return sorted.map((d) => {
    const id = Math.max(d.review.reviewed_at, prev + 1);
    prev = id;
    return [id, d.cid, -1, d.ease, d.ivl, d.lastIvl, d.factor, d.time, d.type];
  });
}
