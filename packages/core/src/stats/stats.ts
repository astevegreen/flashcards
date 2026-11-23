import {
  compareReviewRecords,
  getActiveFsrsParamsVersion,
  isCardSuspended,
  resolveDeckFsrsConfig,
  type CollectionState,
} from '../events/replay.ts';
import {
  applyReviewToSchedule,
  createInitialSchedule,
  getStudyDayIndex,
} from '../fsrs/scheduler.ts';
import type { Card, CardScheduleState, Deck, ReviewRecord } from '../model/types.ts';
import { resolveDayStartHour } from '../study/queue.ts';

/**
 * Phase 11 statistics (§ Phase 11), computed purely from the replayed collection state and its
 * event-derived review log. Nothing here reads the clock or the host timezone: callers pass
 * `nowMs` and `tzOffsetMinutes`.
 *
 * Definitions (kept in one place so the Stats screen and MCP `get_stats` agree):
 * - **Day boundary:** one rollover hour is used for every aggregate view, so reviews, "today" and
 *   the forecast are always labelled against the same calendar. It is the included decks' shared
 *   effective rollover (deck override, else the collection default, same as the study queue) when
 *   they all agree, and the collection-wide default when included decks override it differently.
 *   Filtering to one deck therefore matches that deck's own study days exactly.
 * - **Study day:** a review belongs to `getStudyDayIndex(reviewed_at, review.tz_offset, dayStart)`
 *   with that boundary. The review's own recorded `tz_offset` is used, so travelling never moves
 *   past reviews to another day. Day indexes are labelled with the local calendar date the study
 *   day starts on (`YYYY-MM-DD`).
 * - **Today:** `getStudyDayIndex(nowMs, tzOffsetMinutes, dayStart)` with the same boundary; reviews
 *   that land after it (clock skew, timezone changes) are clamped to today for the windowed views.
 * - **Pass:** rating >= 2 (Hard, Good, Easy). Again is a lapse.
 * - **Maturity:** a card is *mature* when it is in the FSRS Review state with a scheduled interval
 *   (`scheduled_days`) of at least {@link MATURE_INTERVAL_DAYS} days, otherwise *young*. We use the
 *   interval rather than FSRS stability because the interval is what the scheduler actually acted
 *   on and what Anki users know as "mature" (`ivl >= 21`); stability can drift when FSRS
 *   parameters change while the card's real spacing has not. Relearning cards count as learning.
 * - **True retention:** passed / total over reviews in the window whose card was, *just before the
 *   review*, in the Review state. The pre-review state is recovered by replaying the card's active
 *   reviews under the same FSRS parameter versions as `replay`. `mature` is the headline figure;
 *   `young` and `all` (young + mature) are reported too. Learning-step reviews are excluded.
 * - **Undone reviews** (`ReviewUndone`) are excluded everywhere.
 */
export const MATURE_INTERVAL_DAYS = 21;

const MS_PER_DAY = 86_400_000;
const MAX_WINDOW_DAYS = 3660;

export const DEFAULT_STATS_HISTORY_DAYS = 30;
export const DEFAULT_STATS_FORECAST_DAYS = 30;
export const DEFAULT_STATS_HEATMAP_DAYS = 365;
export const DEFAULT_STATS_RETENTION_WINDOW_DAYS = 30;

/**
 * Which cards the statistics cover. Designed so the Phase 9 study filter can plug in later:
 * `deckIds` narrows by deck, and `includeCard` is an arbitrary pure predicate (categories, card
 * state, suspension, ...) evaluated after the deck/archive checks. Archived decks and notes are
 * always excluded: replay drops their derived cards, exactly as the study queue ignores them.
 */
export interface StatsFilter {
  /** Restrict to these decks. Omitted = every deck. */
  deckIds?: Iterable<string>;
  /** Extra pure predicate on each candidate card (e.g. a compiled Phase 9 filter). */
  includeCard?: (card: Card) => boolean;
}

export interface CollectionStatsOptions {
  nowMs: number;
  /** Current device offset in minutes east of UTC (e.g. `-new Date().getTimezoneOffset()`). */
  tzOffsetMinutes: number;
  /** Collection-wide rollover hour override (defaults to `state.preferences.day_start_hour`). */
  dayStartHour?: number;
  filter?: StatsFilter;
  /** Days of "reviews per day" history ending today (default 30). */
  historyDays?: number;
  /** Days of due forecast starting today (default 30). */
  forecastDays?: number;
  /** Days of calendar heatmap ending today (default 365). */
  heatmapDays?: number;
  /** Days of review history used for true retention, ending today (default 30). */
  retentionWindowDays?: number;
}

export interface StatsDayRef {
  /** Study-day index (days since 1970-01-01 in local study-day time). */
  day: number;
  /** Local calendar date the study day starts on, `YYYY-MM-DD`. */
  date: string;
}

export interface ReviewDayStats extends StatsDayRef {
  count: number;
  passed: number;
  /** Reviews rated Again. */
  again: number;
  /** First-ever (active) reviews of a card on this day. */
  newCards: number;
  /** Sum of `duration_ms`. */
  timeMs: number;
}

export interface ReviewsPerDayStats {
  days: ReviewDayStats[];
  totalReviews: number;
  totalTimeMs: number;
  /** Mean reviews per day over the whole window (including days without reviews). */
  averagePerDay: number;
  daysStudied: number;
}

export interface RetentionBucket {
  passed: number;
  total: number;
  /** passed / total rounded to 4 decimals, or `null` when there were no reviews. */
  rate: number | null;
}

export interface RetentionStats {
  windowDays: number;
  /** Desired retention of the included decks, weighted by card count; `null` with no decks. */
  target: number | null;
  deckTargets: Array<{ deckId: string; target: number }>;
  mature: RetentionBucket;
  young: RetentionBucket;
  /** Young + mature (every review of a card that was in the Review state). */
  all: RetentionBucket;
}

export interface ForecastDay extends StatsDayRef {
  /** 0 = today (today also holds overdue cards). */
  offset: number;
  count: number;
  /** Learning / relearning cards due that day. */
  learning: number;
  /** Review-state cards due that day. */
  review: number;
}

export interface DueForecastStats {
  days: ForecastDay[];
  /** Cards whose due study day is before today (already included in `days[0]`). */
  overdue: number;
  /** Sum of `days[*].count`. */
  total: number;
}

export interface HeatmapDay extends StatsDayRef {
  count: number;
  /** 0 = Sunday ... 6 = Saturday, for the local calendar date. */
  weekday: number;
}

export interface HeatmapStats {
  days: HeatmapDay[];
  maxCount: number;
  /**
   * Consecutive study days with at least one review, ending today; if today has no reviews yet the
   * streak still counts up to yesterday (it only breaks once a whole day passes without reviews).
   */
  currentStreak: number;
  /** Longest run over the whole history, not just the heatmap window. */
  longestStreak: number;
  studiedToday: boolean;
  /** Distinct study days with reviews over the whole history. */
  totalDaysStudied: number;
}

export interface MaturityBreakdown {
  new: number;
  learning: number;
  young: number;
  mature: number;
  total: number;
}

export interface CollectionStats {
  nowMs: number;
  today: StatsDayRef;
  /** Included deck ids, sorted. */
  deckIds: string[];
  totals: {
    cards: number;
    reviews: number;
    passed: number;
    timeMs: number;
  };
  reviewsPerDay: ReviewsPerDayStats;
  retention: RetentionStats;
  forecast: DueForecastStats;
  heatmap: HeatmapStats;
  maturity: MaturityBreakdown;
}

function clampWindow(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_WINDOW_DAYS, Math.floor(value)));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function bucket(passed: number, total: number): RetentionBucket {
  return { passed, total, rate: total > 0 ? round4(passed / total) : null };
}

/** `YYYY-MM-DD` for a study-day index (pure arithmetic, no clock access). */
export function studyDayToDateString(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 0 = Sunday for a study-day index (1970-01-01, day 0, was a Thursday). */
export function studyDayWeekday(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

function dayRef(day: number): StatsDayRef {
  return { day, date: studyDayToDateString(day) };
}

/** Whether a schedule counts as mature under the documented rule. */
export function isMatureSchedule(schedule: CardScheduleState): boolean {
  return schedule.state === 2 && schedule.scheduled_days >= MATURE_INTERVAL_DAYS;
}

/** Classifies a card schedule into the maturity breakdown buckets. */
export function classifyCardMaturity(
  schedule: CardScheduleState,
): 'new' | 'learning' | 'young' | 'mature' {
  if (schedule.state === 0) return 'new';
  if (schedule.state === 1 || schedule.state === 3) return 'learning';
  return isMatureSchedule(schedule) ? 'mature' : 'young';
}

/** Active (non-undone) reviews of a card in deterministic replay order. */
function activeReviews(state: CollectionState, cardId: string): ReviewRecord[] {
  const all = state.reviewsByCard.get(cardId);
  if (!all || all.length === 0) return [];
  return all.filter((r) => !state.undoneReviewIds.has(r.review_id)).sort(compareReviewRecords);
}

/** Resolves the decks and cards a filter covers, in deterministic id order. */
export function resolveStatsScope(
  state: CollectionState,
  filter: StatsFilter = {},
): { decks: Deck[]; cards: Card[] } {
  const wanted = filter.deckIds !== undefined ? new Set(filter.deckIds) : undefined;
  const decks = [...state.decks.values()]
    .filter((deck) => (!wanted || wanted.has(deck.id)) && !deck.archived)
    .sort(compareById);

  const cards: Card[] = [];
  for (const deck of decks) {
    for (const cardId of state.cardIdsByDeck.get(deck.id) ?? []) {
      const card = state.cards.get(cardId);
      if (card && isCardInScope(state, card, filter)) cards.push(card);
    }
  }
  cards.sort(compareById);
  return { decks, cards };
}

function compareById(a: { id: string }, b: { id: string }): number {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/** A card counts when its note is active and the optional predicate accepts it. */
function isCardInScope(state: CollectionState, card: Card, filter: StatsFilter): boolean {
  const note = state.notes.get(card.note_id);
  if (!note || note.archived) return false;
  return !filter.includeCard || filter.includeCard(card);
}

/**
 * The single rollover hour used for every aggregate view: the included decks' shared effective
 * `day_start_hour` when they agree, otherwise the collection-wide default. Using one boundary keeps
 * review days, "today" and forecast dates on the same calendar when decks override it differently.
 */
export function resolveAggregateDayStart(decks: readonly Deck[], globalDayStart: number): number {
  let shared: number | undefined;
  for (const deck of decks) {
    const ds = resolveDayStartHour(deck.settings.day_start_hour, globalDayStart);
    if (shared === undefined) shared = ds;
    else if (shared !== ds) return globalDayStart;
  }
  return shared ?? globalDayStart;
}

/** Study-day boundaries shared by every aggregate view of one stats computation. */
interface StatsCalendar {
  dayStart: number;
  today: number;
  historyStart: number;
  heatmapStart: number;
  retentionStart: number;
}

/** Running totals filled while walking the included cards. */
interface StatsAccumulator {
  reviewDays: ReviewDayStats[];
  heatCounts: number[];
  studiedDays: Set<number>;
  forecast: ForecastDay[];
  overdue: number;
  maturity: MaturityBreakdown;
  totalReviews: number;
  totalPassed: number;
  totalTimeMs: number;
  retention: { maturePassed: number; matureTotal: number; youngPassed: number; youngTotal: number };
  cardsPerDeck: Map<string, number>;
}

function createStatsAccumulator(
  calendar: StatsCalendar,
  heatmapDays: number,
  forecastDays: number,
): StatsAccumulator {
  const reviewDays: ReviewDayStats[] = [];
  for (let d = calendar.historyStart; d <= calendar.today; d++) {
    reviewDays.push({ ...dayRef(d), count: 0, passed: 0, again: 0, newCards: 0, timeMs: 0 });
  }
  const forecast: ForecastDay[] = [];
  for (let i = 0; i < forecastDays; i++) {
    forecast.push({ ...dayRef(calendar.today + i), offset: i, count: 0, learning: 0, review: 0 });
  }
  return {
    reviewDays,
    heatCounts: new Array<number>(heatmapDays).fill(0),
    studiedDays: new Set<number>(),
    forecast,
    overdue: 0,
    maturity: { new: 0, learning: 0, young: 0, mature: 0, total: 0 },
    totalReviews: 0,
    totalPassed: 0,
    totalTimeMs: 0,
    retention: { maturePassed: 0, matureTotal: 0, youngPassed: 0, youngTotal: 0 },
    cardsPerDeck: new Map<string, number>(),
  };
}

/** A review's study day under the aggregate boundary, clamped to today. */
function reviewStudyDay(r: ReviewRecord, calendar: StatsCalendar): number {
  return Math.min(calendar.today, getStudyDayIndex(r.reviewed_at, r.tz_offset, calendar.dayStart));
}

/**
 * Due forecast: every non-new card lands on its due study day (overdue folds into today).
 * Suspended and empty cards never come due (Phase 9), so they are left out of the forecast only; their
 * history still counts towards reviews, retention and maturity.
 */
function addCardToForecast(
  state: CollectionState,
  card: Card,
  tzOffsetMinutes: number,
  calendar: StatsCalendar,
  acc: StatsAccumulator,
): void {
  if (card.schedule.state === 0 || card.empty === true || isCardSuspended(state, card.id)) return;
  const dueDay = getStudyDayIndex(card.schedule.due, tzOffsetMinutes, calendar.dayStart);
  const rel = dueDay - calendar.today;
  if (rel < 0) acc.overdue += 1;
  const slot = acc.forecast[Math.max(0, rel)];
  if (!slot) return;
  slot.count += 1;
  if (card.schedule.state === 2) slot.review += 1;
  else slot.learning += 1;
}

function addReviewToHistoryDay(slot: ReviewDayStats, r: ReviewRecord, isFirst: boolean): void {
  slot.count += 1;
  if (r.rating >= 2) slot.passed += 1;
  if (r.rating === 1) slot.again += 1;
  if (isFirst) slot.newCards += 1;
  slot.timeMs += r.duration_ms;
}

/**
 * Adds a card's active reviews to the totals, history, heatmap and studied days. Returns whether
 * any review falls inside the retention window (so the card needs a retention replay).
 */
function tallyCardReviews(
  reviews: readonly ReviewRecord[],
  calendar: StatsCalendar,
  acc: StatsAccumulator,
): boolean {
  let needsRetentionReplay = false;
  for (const [i, r] of reviews.entries()) {
    acc.totalReviews += 1;
    if (r.rating >= 2) acc.totalPassed += 1;
    acc.totalTimeMs += r.duration_ms;

    const day = reviewStudyDay(r, calendar);
    acc.studiedDays.add(day);
    if (day >= calendar.retentionStart) needsRetentionReplay = true;

    const historySlot =
      day >= calendar.historyStart ? acc.reviewDays[day - calendar.historyStart] : undefined;
    if (historySlot) addReviewToHistoryDay(historySlot, r, i === 0);
    if (day >= calendar.heatmapStart) {
      const h = day - calendar.heatmapStart;
      acc.heatCounts[h] = (acc.heatCounts[h] ?? 0) + 1;
    }
  }
  return needsRetentionReplay;
}

/**
 * True retention needs the pre-review schedule: replays the card's active reviews under their
 * recorded FSRS parameter versions and counts window reviews of Review-state cards.
 */
function tallyTrueRetention(
  state: CollectionState,
  card: Card,
  reviews: readonly ReviewRecord[],
  calendar: StatsCalendar,
  retention: StatsAccumulator['retention'],
): void {
  let schedule = createInitialSchedule(0);
  for (const r of reviews) {
    const inWindow = reviewStudyDay(r, calendar) >= calendar.retentionStart;
    if (inWindow && schedule.state === 2) {
      const passed = r.rating >= 2 ? 1 : 0;
      if (isMatureSchedule(schedule)) {
        retention.matureTotal += 1;
        retention.maturePassed += passed;
      } else {
        retention.youngTotal += 1;
        retention.youngPassed += passed;
      }
    }
    const config = resolveDeckFsrsConfig(state, card.deck_id, r.reviewed_at, r.fsrs_params_version);
    schedule = applyReviewToSchedule(schedule, r.rating, r.reviewed_at, config).next;
  }
}

function tallyCard(
  state: CollectionState,
  card: Card,
  tzOffsetMinutes: number,
  calendar: StatsCalendar,
  acc: StatsAccumulator,
): void {
  acc.cardsPerDeck.set(card.deck_id, (acc.cardsPerDeck.get(card.deck_id) ?? 0) + 1);

  // Maturity breakdown from the current (replayed) schedule.
  acc.maturity[classifyCardMaturity(card.schedule)] += 1;
  acc.maturity.total += 1;

  addCardToForecast(state, card, tzOffsetMinutes, calendar, acc);

  const reviews = activeReviews(state, card.id);
  if (reviews.length === 0) return;
  // Only replay cards reviewed in the retention window.
  if (tallyCardReviews(reviews, calendar, acc)) {
    tallyTrueRetention(state, card, reviews, calendar, acc.retention);
  }
}

/** Retention targets: the desired retention the scheduler uses for new reviews on each deck. */
function computeRetentionTargets(
  state: CollectionState,
  decks: readonly Deck[],
  cardsPerDeck: Map<string, number>,
  nowMs: number,
): { target: number | null; deckTargets: Array<{ deckId: string; target: number }> } {
  const deckTargets: Array<{ deckId: string; target: number }> = [];
  let weightedTarget = 0;
  let weight = 0;
  for (const deck of decks) {
    const config = resolveDeckFsrsConfig(
      state,
      deck.id,
      nowMs,
      getActiveFsrsParamsVersion(state, deck.id),
    );
    const target = config.request_retention;
    deckTargets.push({ deckId: deck.id, target });
    const w = cardsPerDeck.get(deck.id) ?? 0;
    weightedTarget += target * w;
    weight += w;
  }
  let target: number | null = null;
  if (weight > 0) {
    target = round4(weightedTarget / weight);
  } else if (deckTargets.length > 0) {
    target = round4(deckTargets.reduce((s, t) => s + t.target, 0) / deckTargets.length);
  }
  return { target, deckTargets };
}

function summarizeReviewsPerDay(
  reviewDays: ReviewDayStats[],
  historyDays: number,
): ReviewsPerDayStats {
  let windowReviews = 0;
  let windowTime = 0;
  let windowStudied = 0;
  for (const d of reviewDays) {
    windowReviews += d.count;
    windowTime += d.timeMs;
    if (d.count > 0) windowStudied += 1;
  }
  return {
    days: reviewDays,
    totalReviews: windowReviews,
    totalTimeMs: windowTime,
    averagePerDay: round4(windowReviews / historyDays),
    daysStudied: windowStudied,
  };
}

function longestStudyStreak(studiedDays: ReadonlySet<number>): number {
  let longestStreak = 0;
  let run = 0;
  let prev: number | undefined;
  for (const d of [...studiedDays].sort((a, b) => a - b)) {
    run = prev !== undefined && d === prev + 1 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = d;
  }
  return longestStreak;
}

function buildHeatmap(
  heatCounts: readonly number[],
  studiedDays: ReadonlySet<number>,
  calendar: StatsCalendar,
  heatmapDays: number,
): HeatmapStats {
  const { today, heatmapStart } = calendar;
  const heatDays: HeatmapDay[] = [];
  let maxCount = 0;
  for (let i = 0; i < heatmapDays; i++) {
    const day = heatmapStart + i;
    const count = heatCounts[i] ?? 0;
    if (count > maxCount) maxCount = count;
    heatDays.push({ ...dayRef(day), count, weekday: studyDayWeekday(day) });
  }
  const studiedToday = studiedDays.has(today);
  let currentStreak = 0;
  for (let d = studiedToday ? today : today - 1; studiedDays.has(d); d--) {
    currentStreak += 1;
  }
  return {
    days: heatDays,
    maxCount,
    currentStreak,
    longestStreak: longestStudyStreak(studiedDays),
    studiedToday,
    totalDaysStudied: studiedDays.size,
  };
}

/**
 * Computes every Phase 11 statistic for the cards selected by `options.filter`.
 * Deterministic: the same state and options always give the same result.
 */
export function computeCollectionStats(
  state: CollectionState,
  options: CollectionStatsOptions,
): CollectionStats {
  const { nowMs, tzOffsetMinutes } = options;
  const globalDayStart = options.dayStartHour ?? state.preferences.day_start_hour;
  const historyDays = clampWindow(options.historyDays, DEFAULT_STATS_HISTORY_DAYS);
  const forecastDays = clampWindow(options.forecastDays, DEFAULT_STATS_FORECAST_DAYS);
  const heatmapDays = clampWindow(options.heatmapDays, DEFAULT_STATS_HEATMAP_DAYS);
  const retentionDays = clampWindow(
    options.retentionWindowDays,
    DEFAULT_STATS_RETENTION_WINDOW_DAYS,
  );

  const { decks, cards } = resolveStatsScope(state, options.filter);

  const dayStart = resolveAggregateDayStart(decks, globalDayStart);
  const today = getStudyDayIndex(nowMs, tzOffsetMinutes, dayStart);
  const calendar: StatsCalendar = {
    dayStart,
    today,
    historyStart: today - historyDays + 1,
    heatmapStart: today - heatmapDays + 1,
    retentionStart: today - retentionDays + 1,
  };

  const acc = createStatsAccumulator(calendar, heatmapDays, forecastDays);
  for (const card of cards) tallyCard(state, card, tzOffsetMinutes, calendar, acc);

  const { target, deckTargets } = computeRetentionTargets(state, decks, acc.cardsPerDeck, nowMs);
  const { maturePassed, matureTotal, youngPassed, youngTotal } = acc.retention;

  let forecastTotal = 0;
  for (const f of acc.forecast) forecastTotal += f.count;

  return {
    nowMs,
    today: dayRef(today),
    deckIds: decks.map((d) => d.id),
    totals: {
      cards: cards.length,
      reviews: acc.totalReviews,
      passed: acc.totalPassed,
      timeMs: acc.totalTimeMs,
    },
    reviewsPerDay: summarizeReviewsPerDay(acc.reviewDays, historyDays),
    retention: {
      windowDays: retentionDays,
      target,
      deckTargets,
      mature: bucket(maturePassed, matureTotal),
      young: bucket(youngPassed, youngTotal),
      all: bucket(maturePassed + youngPassed, matureTotal + youngTotal),
    },
    forecast: { days: acc.forecast, overdue: acc.overdue, total: forecastTotal },
    heatmap: buildHeatmap(acc.heatCounts, acc.studiedDays, calendar, heatmapDays),
    maturity: acc.maturity,
  };
}
