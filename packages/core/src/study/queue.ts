import { isCardSuspended, type CollectionState } from '../events/replay.ts';
import { getNextStudyDayRolloverMs, getStudyDayIndex } from '../fsrs/scheduler.ts';
import type { Card, Deck } from '../model/types.ts';
import { filterCardIds, isCardFilterEmpty, type CardFilter } from './filter.ts';
import {
  isCardInRaiseScope,
  isRaiseOnDay,
  listNewCardRaises,
  type NewCardRaise,
} from './new-card-raises.ts';

export interface StudyQueueOptions {
  deckId?: string;
  nowMs: number;
  /** Minutes east of UTC (e.g., `-new Date().getTimezoneOffset()`). */
  tzOffsetMinutes: number;
  /** Optional override for study day rollover hour (defaults to state.preferences.day_start_hour = 4). */
  dayStartHour?: number;
  /**
   * Phase 9 filtered study: only cards matching this filter are queued. The schedule, daily
   * limits and sibling burying are exactly those of the unfiltered queue (no forked FSRS state).
   */
  filter?: CardFilter;
}

/**
 * Effective study-day rollover hour for a deck. A deck override of `undefined` or a negative
 * value (the UI's "collection default", since LWW settings can't be unset) falls back to global.
 */
export function resolveDayStartHour(deckOverride: number | undefined, globalHour: number): number {
  return deckOverride !== undefined && deckOverride >= 0 && deckOverride <= 23
    ? deckOverride
    : globalHour;
}

export interface StudyCounts {
  new: number;
  learning: number;
  due: number;
  total: number;
}

export interface StudyQueueResult {
  queue: Card[];
  counts: StudyCounts;
  buriedNoteIds: Set<string>;
  /** Earliest due timestamp (Unix ms) among unburied intraday learning/relearning cards due later today. */
  nextLearningDueAt?: number;
}

/** Simple deterministic hash for reproducible daily random new-card ordering. */
function hashString32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Shared inputs of the queue-building passes. */
interface QueueContext {
  state: CollectionState;
  nowMs: number;
  tzOffsetMinutes: number;
  globalDayStart: number;
}

function deckDayStart(ctx: QueueContext, deck: Deck): number {
  return resolveDayStartHour(deck.settings.day_start_hour, ctx.globalDayStart);
}

function incrementCount(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Ids allowed by a non-empty Phase 9 filter, or `undefined` when every card is eligible. */
function resolveAllowedCardIds(
  state: CollectionState,
  options: StudyQueueOptions,
): Set<string> | undefined {
  if (options.filter === undefined || isCardFilterEmpty(options.filter)) return undefined;
  return filterCardIds(state, options.filter, {
    nowMs: options.nowMs,
    tzOffsetMinutes: options.tzOffsetMinutes,
    ...(options.dayStartHour !== undefined ? { dayStartHour: options.dayStartHour } : {}),
    excludeSuspended: true,
  });
}

/** What today's active (not undone) reviews of a deck's cards have already consumed. */
interface TodayActivity {
  /** Notes with a card reviewed today: their siblings are buried. */
  reviewedNoteIdsToday: Set<string>;
  reviewsTodayByDeck: Map<string, number>;
  newCardsStartedTodayByDeck: Map<string, number>;
  /** New cards first studied today with their first active review time (extra-new-card pools). */
  startedToday: Array<{ card: Card; at: number }>;
}

/** Active reviews of one card on study day `todayIndex`, plus whether its first ever active review was today. */
function summarizeCardReviewsToday(
  ctx: QueueContext,
  cardId: string,
  dayStart: number,
  todayIndex: number,
): { activeCountToday: number; startedToday: boolean; firstActiveReviewTime: number } {
  const { state, tzOffsetMinutes } = ctx;
  let firstActiveReviewTime = Infinity;
  let activeCountToday = 0;
  for (const r of state.reviewsByCard.get(cardId) ?? []) {
    if (state.undoneReviewIds.has(r.review_id)) continue;
    if (r.reviewed_at < firstActiveReviewTime) {
      firstActiveReviewTime = r.reviewed_at;
    }
    if (getStudyDayIndex(r.reviewed_at, tzOffsetMinutes, dayStart) === todayIndex) {
      activeCountToday += 1;
    }
  }
  const startedToday =
    firstActiveReviewTime < Infinity &&
    getStudyDayIndex(firstActiveReviewTime, tzOffsetMinutes, dayStart) === todayIndex;
  return { activeCountToday, startedToday, firstActiveReviewTime };
}

function collectTodayActivity(ctx: QueueContext): TodayActivity {
  const { state } = ctx;
  const activity: TodayActivity = {
    reviewedNoteIdsToday: new Set(),
    reviewsTodayByDeck: new Map(),
    newCardsStartedTodayByDeck: new Map(),
    startedToday: [],
  };
  for (const card of state.cards.values()) {
    const deck = state.decks.get(card.deck_id);
    if (!deck || deck.archived) continue;
    if ((state.reviewsByCard.get(card.id)?.length ?? 0) === 0) continue;
    const dayStart = deckDayStart(ctx, deck);
    const todayIndex = getStudyDayIndex(ctx.nowMs, ctx.tzOffsetMinutes, dayStart);
    const { activeCountToday, startedToday, firstActiveReviewTime } = summarizeCardReviewsToday(
      ctx,
      card.id,
      dayStart,
      todayIndex,
    );
    if (activeCountToday === 0) continue;
    activity.reviewedNoteIdsToday.add(card.note_id);
    incrementCount(activity.reviewsTodayByDeck, card.deck_id, activeCountToday);
    if (startedToday) {
      incrementCount(activity.newCardsStartedTodayByDeck, card.deck_id, 1);
      activity.startedToday.push({ card, at: firstActiveReviewTime });
    }
  }
  return activity;
}

/** Cards eligible today, grouped before limits and in-queue sibling burying apply. */
interface EligibleCards {
  learningCards: Card[];
  dueCards: Card[];
  newCardsByDeck: Map<string, Card[]>;
  buriedNoteIds: Set<string>;
  nextLearningDueAt?: number;
}

/** The card's deck when the card may be queued at all (scope, filter, suspension, archive). */
function eligibleDeckOf(
  ctx: QueueContext,
  card: Card,
  deckId: string | undefined,
  allowedCardIds: Set<string> | undefined,
): Deck | undefined {
  const { state } = ctx;
  if (deckId !== undefined && card.deck_id !== deckId) return undefined;
  if (allowedCardIds !== undefined && !allowedCardIds.has(card.id)) return undefined;
  if (isCardSuspended(state, card.id)) return undefined;
  const deck = state.decks.get(card.deck_id);
  if (!deck || deck.archived) return undefined;
  const note = state.notes.get(card.note_id);
  if (!note || note.archived) return undefined;
  return deck;
}

/**
 * Learning or Relearning: due now (or within the current study day if already in a learning
 * step). A card already in learning today is NOT buried against itself; only siblings are buried.
 */
function placeLearningCard(
  ctx: QueueContext,
  card: Card,
  dayStart: number,
  reviewedNoteIdsToday: Set<string>,
  out: EligibleCards,
): void {
  const { nowMs, tzOffsetMinutes } = ctx;
  const wasThisCardReviewedToday =
    card.last_reviewed_at !== undefined &&
    getStudyDayIndex(card.last_reviewed_at, tzOffsetMinutes, dayStart) ===
      getStudyDayIndex(nowMs, tzOffsetMinutes, dayStart);
  if (!wasThisCardReviewedToday && reviewedNoteIdsToday.has(card.note_id)) {
    out.buriedNoteIds.add(card.note_id);
    return;
  }
  const due = card.schedule.due;
  if (due <= nowMs) {
    out.learningCards.push(card);
    return;
  }
  const endOfTodayMs = getNextStudyDayRolloverMs(nowMs, tzOffsetMinutes, dayStart);
  if (due < endOfTodayMs && (out.nextLearningDueAt === undefined || due < out.nextLearningDueAt)) {
    out.nextLearningDueAt = due;
  }
}

function placeEligibleCard(
  ctx: QueueContext,
  card: Card,
  deck: Deck,
  reviewedNoteIdsToday: Set<string>,
  out: EligibleCards,
): void {
  const dayStart = deckDayStart(ctx, deck);
  const s = card.schedule;
  if (s.state === 1 || s.state === 3) {
    placeLearningCard(ctx, card, dayStart, reviewedNoteIdsToday, out);
    return;
  }
  // Review and new cards are buried by any sibling reviewed today.
  if (reviewedNoteIdsToday.has(card.note_id)) {
    out.buriedNoteIds.add(card.note_id);
    return;
  }
  if (s.state === 2) {
    const endOfTodayMs = getNextStudyDayRolloverMs(ctx.nowMs, ctx.tzOffsetMinutes, dayStart);
    if (s.due < endOfTodayMs) out.dueCards.push(card);
    return;
  }
  // New card (state === 0)
  const list = out.newCardsByDeck.get(card.deck_id) ?? [];
  list.push(card);
  out.newCardsByDeck.set(card.deck_id, list);
}

function collectEligibleCards(
  ctx: QueueContext,
  deckId: string | undefined,
  allowedCardIds: Set<string> | undefined,
  reviewedNoteIdsToday: Set<string>,
): EligibleCards {
  const out: EligibleCards = {
    learningCards: [],
    dueCards: [],
    newCardsByDeck: new Map(),
    buriedNoteIds: new Set(),
  };
  for (const card of ctx.state.cards.values()) {
    const deck = eligibleDeckOf(ctx, card, deckId, allowedCardIds);
    if (deck) placeEligibleCard(ctx, card, deck, reviewedNoteIdsToday, out);
  }
  return out;
}

/** Earliest due first, then card id. */
function compareByDue(a: Card, b: Card): number {
  return a.schedule.due - b.schedule.due || (a.id < b.id ? -1 : 1);
}

/** Reproducible daily random order for `new_card_order: 'random'`. */
function compareDailyRandom(todayIndex: number): (a: Card, b: Card) => number {
  return (a, b) => {
    const ha = hashString32(`${todayIndex}:${a.id}`);
    const hb = hashString32(`${todayIndex}:${b.id}`);
    return ha - hb || (a.id < b.id ? -1 : 1);
  };
}

/** Recognition layouts sort before production layouts, then by layout id. */
function compareLayouts(a: string, b: string): number {
  const aIsRec = a.includes('recognition') ? 0 : 1;
  const bIsRec = b.includes('recognition') ? 0 : 1;
  if (aIsRec !== bIsRec) return aIsRec - bIsRec;
  return a < b ? -1 : 1;
}

/** Source order: by note.created_order, then layout order (Recognition before Production), then variant, then id. */
function compareSourceOrder(state: CollectionState): (a: Card, b: Card) => number {
  return (a, b) => {
    const oa = state.notes.get(a.note_id)?.created_order ?? 0;
    const ob = state.notes.get(b.note_id)?.created_order ?? 0;
    if (oa !== ob) return oa - ob;
    if (a.layout_id !== b.layout_id) return compareLayouts(a.layout_id, b.layout_id);
    if (a.variant !== b.variant) return a.variant - b.variant;
    return a.id < b.id ? -1 : 1;
  };
}

/** Code-unit order (not localeCompare): queues must be identical on every device. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Remaining quota of one extra-new-cards raise while a queue is built. */
interface RaisePool {
  raise: NewCardRaise;
  left: number;
}

/** A raise is at most this far from now when it is on today's study day (any offset / rollover). */
const RAISE_WINDOW_MS = 3 * 86_400_000;

function hasOpenPool(pools: readonly RaisePool[]): boolean {
  return pools.some((p) => p.left > 0);
}

/** First open pool that may take `card` today (deck, categories and study day all match). */
function findRaisePool(
  ctx: QueueContext,
  pools: readonly RaisePool[],
  card: Card,
): RaisePool | undefined {
  if (pools.length === 0) return undefined;
  const { state } = ctx;
  const dayStart = resolveDayStartHour(
    state.decks.get(card.deck_id)?.settings.day_start_hour,
    ctx.globalDayStart,
  );
  const todayIndex = getStudyDayIndex(ctx.nowMs, ctx.tzOffsetMinutes, dayStart);
  return pools.find(
    (p) =>
      p.left > 0 &&
      isRaiseOnDay(p.raise, todayIndex, ctx.tzOffsetMinutes, dayStart) &&
      isCardInRaiseScope(state, p.raise, card),
  );
}

/**
 * Today's extra-new-card pools, each raise spent once for its whole scope. New cards first studied
 * today beyond their deck's normal limit (in first-review order) already used the first matching
 * pool, so the result depends only on the log, never on which deck or filter the queue is for.
 */
function openRaisePools(
  ctx: QueueContext,
  startedToday: ReadonlyArray<{ card: Card; at: number }>,
): RaisePool[] {
  const { state } = ctx;
  const pools = listNewCardRaises(state)
    .filter((r) => Math.abs(r.raisedAt - ctx.nowMs) <= RAISE_WINDOW_MS)
    .map((raise) => ({ raise, left: raise.extra }));
  if (pools.length === 0) return pools;
  const ordered = [...startedToday].sort(
    (a, b) => a.at - b.at || compareCodeUnits(a.card.id, b.card.id),
  );
  const seenByDeck = new Map<string, number>();
  for (const { card } of ordered) {
    const limit = state.decks.get(card.deck_id)?.settings.new_cards_per_day ?? 0;
    const seen = (seenByDeck.get(card.deck_id) ?? 0) + 1;
    seenByDeck.set(card.deck_id, seen);
    if (seen <= limit) continue;
    const pool = findRaisePool(ctx, pools, card);
    if (pool) pool.left -= 1;
  }
  return pools;
}

/** Selected cards plus in-queue sibling burying state (at most one card per note_id). */
interface QueueSelection {
  queuedNoteIds: Set<string>;
  buriedNoteIds: Set<string>;
}

/** Queues `card` unless a sibling is already queued (then its note is buried). */
function tryQueue(selection: QueueSelection, card: Card, into: Card[]): boolean {
  if (selection.queuedNoteIds.has(card.note_id)) {
    selection.buriedNoteIds.add(card.note_id);
    return false;
  }
  selection.queuedNoteIds.add(card.note_id);
  into.push(card);
  return true;
}

/** Due review cards within each deck's `max_reviews_per_day` (counting reviews done today). */
function selectDueCards(
  state: CollectionState,
  dueCards: readonly Card[],
  reviewsTodayByDeck: Map<string, number>,
  selection: QueueSelection,
): Card[] {
  const finalDue: Card[] = [];
  const queuedDueByDeck = new Map<string, number>();
  for (const card of dueCards) {
    if (selection.queuedNoteIds.has(card.note_id)) {
      selection.buriedNoteIds.add(card.note_id);
      continue;
    }
    const deck = state.decks.get(card.deck_id);
    if (!deck) continue;
    const doneToday = reviewsTodayByDeck.get(card.deck_id) ?? 0;
    const queuedForDeck = queuedDueByDeck.get(card.deck_id) ?? 0;
    if (doneToday + queuedForDeck >= deck.settings.max_reviews_per_day) continue;
    tryQueue(selection, card, finalDue);
    queuedDueByDeck.set(card.deck_id, queuedForDeck + 1);
  }
  return finalDue;
}

/**
 * New cards per deck (sorted deck ids) within `new_cards_per_day`, in `new_card_order`, plus
 * custom-study extra new cards today (each raise one pool shared by its decks / categories).
 */
function selectNewCards(
  ctx: QueueContext,
  newCardsByDeck: Map<string, Card[]>,
  activity: TodayActivity,
  selection: QueueSelection,
): Card[] {
  const { state } = ctx;
  const finalNew: Card[] = [];
  const pools = openRaisePools(ctx, activity.startedToday);
  const deckIdsSorted = [...newCardsByDeck.keys()].sort(compareCodeUnits);
  for (const dId of deckIdsSorted) {
    const deck = state.decks.get(dId);
    const candidates = newCardsByDeck.get(dId);
    if (!deck || !candidates) continue;
    const alreadyStarted = activity.newCardsStartedTodayByDeck.get(dId) ?? 0;
    const baseQuota = Math.max(0, deck.settings.new_cards_per_day - alreadyStarted);
    if (baseQuota === 0 && !hasOpenPool(pools)) continue;
    const todayIndex = getStudyDayIndex(ctx.nowMs, ctx.tzOffsetMinutes, deckDayStart(ctx, deck));
    candidates.sort(
      deck.settings.new_card_order === 'random'
        ? compareDailyRandom(todayIndex)
        : compareSourceOrder(state),
    );
    takeNewCards(ctx, candidates, { baseQuota, pools }, selection, finalNew);
  }
  return finalNew;
}

/**
 * Queues sorted candidates in order: first within the deck's own remaining quota, then while a
 * matching extra-new-card pool has room (siblings get buried).
 */
function takeNewCards(
  ctx: QueueContext,
  candidates: readonly Card[],
  quota: { baseQuota: number; pools: readonly RaisePool[] },
  selection: QueueSelection,
  into: Card[],
): void {
  let baseLeft = quota.baseQuota;
  for (const card of candidates) {
    if (baseLeft > 0) {
      if (tryQueue(selection, card, into)) baseLeft -= 1;
      continue;
    }
    if (!hasOpenPool(quota.pools)) break;
    const pool = findRaisePool(ctx, quota.pools, card);
    if (pool && tryQueue(selection, card, into)) pool.left -= 1;
  }
}

/**
 * Builds today's study queue for a deck or the whole collection.
 * Enforces:
 * - Study-day rollover (default 04:00 local time)
 * - Per-deck `new_cards_per_day` & `max_reviews_per_day`, plus custom-study extra new cards today
 *   (each `NewCardLimitRaised` is one pool shared by its decks / categories, spent once)
 * - `new_card_order` (`source` | `random`)
 * - Sibling burying (§5.1): if one card of a `note_id` was reviewed today (or is queued),
 *   sibling cards of the same note are buried until the next study day.
 * - Suspended cards (`CardSuspended`) are never queued.
 * - Optional Phase 9 `filter`: restricts which cards are eligible.
 */
export function buildStudyQueue(
  state: CollectionState,
  options: StudyQueueOptions,
): StudyQueueResult {
  const ctx: QueueContext = {
    state,
    nowMs: options.nowMs,
    tzOffsetMinutes: options.tzOffsetMinutes,
    globalDayStart: options.dayStartHour ?? state.preferences.day_start_hour,
  };
  const allowedCardIds = resolveAllowedCardIds(state, options);

  // Which notes already had a card reviewed today (sibling burying) and the per-deck
  // new/review quotas consumed today.
  const activity = collectTodayActivity(ctx);

  // Group eligible cards into learning, due, new per deck.
  const eligible = collectEligibleCards(
    ctx,
    options.deckId,
    allowedCardIds,
    activity.reviewedNoteIdsToday,
  );
  eligible.learningCards.sort(compareByDue);
  eligible.dueCards.sort(compareByDue);

  // Enforce sibling burying within the queue itself (at most one card per note_id).
  const selection: QueueSelection = {
    queuedNoteIds: new Set(),
    buriedNoteIds: eligible.buriedNoteIds,
  };
  const finalLearning: Card[] = [];
  for (const card of eligible.learningCards) tryQueue(selection, card, finalLearning);
  const finalDue = selectDueCards(state, eligible.dueCards, activity.reviewsTodayByDeck, selection);
  const finalNew = selectNewCards(ctx, eligible.newCardsByDeck, activity, selection);

  const queue = [...finalLearning, ...finalDue, ...finalNew];
  const result: StudyQueueResult = {
    queue,
    counts: {
      new: finalNew.length,
      learning: finalLearning.length,
      due: finalDue.length,
      total: queue.length,
    },
    buriedNoteIds: selection.buriedNoteIds,
  };
  if (eligible.nextLearningDueAt !== undefined) {
    result.nextLearningDueAt = eligible.nextLearningDueAt;
  }
  return result;
}
