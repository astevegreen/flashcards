import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  type Card as FsrsCard,
  type FSRS,
  type FSRSParameters,
  type Grade,
} from 'ts-fsrs';
import type {
  CardLearningState,
  CardScheduleState,
  FSRSParamsConfig,
  ReviewRating,
} from '../model/types.ts';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export const DEFAULT_FSRS_CONFIG: FSRSParamsConfig = {
  request_retention: 0.9,
  enable_fuzz: false,
  enable_short_term: true,
};

function buildFsrsParams(config?: Partial<FSRSParamsConfig>): FSRSParameters {
  const partial: Partial<FSRSParameters> = {
    request_retention: config?.request_retention ?? DEFAULT_FSRS_CONFIG.request_retention,
    enable_fuzz: config?.enable_fuzz ?? false,
    enable_short_term: config?.enable_short_term ?? true,
  };
  if (config?.maximum_interval !== undefined) {
    partial.maximum_interval = config.maximum_interval;
  }
  if (config?.w !== undefined) {
    partial.w = config.w;
  }
  return generatorParameters(partial);
}

/** Schedulers by effective params. Bounded: an optimizer run may try many weight sets. */
const schedulers = new Map<string, FSRS>();
const MAX_SCHEDULERS = 32;

/**
 * One ts-fsrs scheduler per distinct params (P4): replay used to build one for every review. The
 * key is the params themselves, so a params change (new version, optimized weights) gets a new
 * scheduler and a cached one can never go stale. A scheduler keeps no per-review state.
 */
function schedulerFor(config?: Partial<FSRSParamsConfig>): FSRS {
  const key = [
    config?.request_retention ?? DEFAULT_FSRS_CONFIG.request_retention,
    config?.enable_fuzz ?? false,
    config?.enable_short_term ?? true,
    config?.maximum_interval,
    config?.w,
  ].join('|');
  let scheduler = schedulers.get(key);
  if (!scheduler) {
    if (schedulers.size >= MAX_SCHEDULERS) schedulers.clear();
    scheduler = fsrs(buildFsrsParams(config));
    schedulers.set(key, scheduler);
  }
  return scheduler;
}

function toFsrsCard(schedule: CardScheduleState): FsrsCard {
  const card: FsrsCard = {
    due: new Date(schedule.due),
    stability: schedule.stability,
    difficulty: schedule.difficulty,
    scheduled_days: schedule.scheduled_days,
    learning_steps: schedule.learning_steps,
    reps: schedule.reps,
    lapses: schedule.lapses,
    state: schedule.state,
  };
  if (schedule.last_review !== undefined) {
    card.last_review = new Date(schedule.last_review);
  }
  return card;
}

function fromFsrsCard(card: FsrsCard): CardScheduleState {
  const out: CardScheduleState = {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as CardLearningState,
  };
  if (card.last_review !== undefined) {
    out.last_review = card.last_review.getTime();
  }
  return out;
}

function toGrade(rating: ReviewRating): Grade {
  switch (rating) {
    case 1:
      return Rating.Again;
    case 2:
      return Rating.Hard;
    case 3:
      return Rating.Good;
    case 4:
      return Rating.Easy;
  }
}

export function createInitialSchedule(nowMs = 0): CardScheduleState {
  return fromFsrsCard(createEmptyCard(new Date(nowMs)));
}

export function applyReviewToSchedule(
  schedule: CardScheduleState,
  rating: ReviewRating,
  reviewedAtMs: number,
  config?: Partial<FSRSParamsConfig>,
): { next: CardScheduleState; resulting_due_at: number } {
  const scheduler = schedulerFor(config);
  const fsrsCard = toFsrsCard(schedule);
  const result = scheduler.next(fsrsCard, new Date(reviewedAtMs), toGrade(rating));
  const next = fromFsrsCard(result.card);
  return {
    next,
    resulting_due_at: next.due,
  };
}

export interface IntervalPreview {
  due: number;
  scheduled_days: number;
  label: string;
}

export function formatIntervalLabel(dueMs: number, nowMs: number): string {
  const diffMs = Math.max(0, dueMs - nowMs);
  if (diffMs < MS_PER_MINUTE) {
    return '<1m';
  }
  if (diffMs < MS_PER_HOUR) {
    const mins = Math.max(1, Math.round(diffMs / MS_PER_MINUTE));
    return `${mins}m`;
  }
  if (diffMs < MS_PER_DAY) {
    const hours = Math.max(1, Math.round(diffMs / MS_PER_HOUR));
    return `${hours}h`;
  }
  const days = diffMs / MS_PER_DAY;
  if (days < 30) {
    return `${Math.round(days)}d`;
  }
  if (days < 365) {
    const months = days / 30;
    return months < 10 ? `${months.toFixed(1).replace(/\.0$/, '')}mo` : `${Math.round(months)}mo`;
  }
  const years = days / 365;
  return `${years.toFixed(1).replace(/\.0$/, '')}y`;
}

export function previewIntervals(
  schedule: CardScheduleState,
  nowMs: number,
  config?: Partial<FSRSParamsConfig>,
): Record<ReviewRating, IntervalPreview> {
  const scheduler = schedulerFor(config);
  const fsrsCard = toFsrsCard(schedule);
  const outcomes = scheduler.repeat(fsrsCard, new Date(nowMs));

  const ratings: ReviewRating[] = [1, 2, 3, 4];
  const previews = {} as Record<ReviewRating, IntervalPreview>;
  for (const r of ratings) {
    const outcome = outcomes[toGrade(r)].card;
    const due = outcome.due.getTime();
    previews[r] = {
      due,
      scheduled_days: outcome.scheduled_days,
      label: formatIntervalLabel(due, nowMs),
    };
  }
  return previews;
}

/**
 * Computes an integer study-day index for a timestamp, accounting for local timezone offset
 * (minutes east of UTC, e.g. -Date.getTimezoneOffset()) and study-day rollover hour (default 04:00).
 */
export function getStudyDayIndex(
  timestampMs: number,
  tzOffsetMinutes: number,
  dayStartHour = 4,
): number {
  const clampedHour = Math.max(0, Math.min(23, Math.floor(dayStartHour)));
  const localShiftedMs = timestampMs + tzOffsetMinutes * MS_PER_MINUTE - clampedHour * MS_PER_HOUR;
  return Math.floor(localShiftedMs / MS_PER_DAY);
}

/**
 * Returns the Unix ms timestamp of the next study-day rollover after `nowMs`.
 */
export function getNextStudyDayRolloverMs(
  nowMs: number,
  tzOffsetMinutes: number,
  dayStartHour = 4,
): number {
  const currentDay = getStudyDayIndex(nowMs, tzOffsetMinutes, dayStartHour);
  const clampedHour = Math.max(0, Math.min(23, Math.floor(dayStartHour)));
  return (
    (currentDay + 1) * MS_PER_DAY + clampedHour * MS_PER_HOUR - tzOffsetMinutes * MS_PER_MINUTE
  );
}
