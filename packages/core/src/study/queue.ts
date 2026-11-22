import { isCardSuspended, type CollectionState } from '../events/replay.ts';
import { getNextStudyDayRolloverMs, getStudyDayIndex } from '../fsrs/scheduler.ts';
import type { Card } from '../model/types.ts';
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

/**
 * Extra new cards custom study granted today by raises whose deck scope includes `deckId`
 * (`NewCardLimitRaised`, kept verbatim in `unknownEvents`), whatever their category scope. A raise
 * counts on the study day containing its `raised_at` (in the raising device's offset, with the
 * deck's rollover hour). Raises add up; a repeated `raise_id` counts once (its largest value), so
 * the result is independent of delivery order and duplicates.
 *
 * This is the gross grant: a raise shared by several decks is counted in full for each of them.
 * {@link buildStudyQueue} spends each raise once, as one pool for its whole scope.
 */
export function getExtraNewCardsToday(
  state: CollectionState,
  deckId: string,
  nowMs: number,
  tzOffsetMinutes: number,
  dayStartHour: number,
): number {
  const today = getStudyDayIndex(nowMs, tzOffsetMinutes, dayStartHour);
  let extra = 0;
  for (const r of listNewCardRaises(state)) {
    if (r.deckIds !== null && !r.deckIds.has(deckId)) continue;
    if (!isRaiseOnDay(r, today, tzOffsetMinutes, dayStartHour)) continue;
    extra += r.extra;
  }
  return extra;
}

/** Remaining quota of one extra-new-cards raise while a queue is built. */
interface RaisePool {
  raise: NewCardRaise;
  left: number;
}

/** A raise is at most this far from now when it is on today's study day (any offset / rollover). */
const RAISE_WINDOW_MS = 3 * 86_400_000;

/** First open pool that may take `card` today (deck, categories and study day all match). */
function findRaisePool(
  state: CollectionState,
  pools: readonly RaisePool[],
  card: Card,
  nowMs: number,
  tzOffsetMinutes: number,
  globalDayStart: number,
): RaisePool | undefined {
  if (pools.length === 0) return undefined;
  const dayStart = resolveDayStartHour(
    state.decks.get(card.deck_id)?.settings.day_start_hour,
    globalDayStart,
  );
  const todayIndex = getStudyDayIndex(nowMs, tzOffsetMinutes, dayStart);
  return pools.find(
    (p) =>
      p.left > 0 &&
      isRaiseOnDay(p.raise, todayIndex, tzOffsetMinutes, dayStart) &&
      isCardInRaiseScope(state, p.raise, card),
  );
}

/**
 * Today's extra-new-card pools, each raise spent once for its whole scope. New cards first studied
 * today beyond their deck's normal limit (in first-review order) already used the first matching
 * pool, so the result depends only on the log, never on which deck or filter the queue is for.
 */
function openRaisePools(
  state: CollectionState,
  startedToday: ReadonlyArray<{ card: Card; at: number }>,
  nowMs: number,
  tzOffsetMinutes: number,
  globalDayStart: number,
): RaisePool[] {
  const pools = listNewCardRaises(state)
    .filter((r) => Math.abs(r.raisedAt - nowMs) <= RAISE_WINDOW_MS)
    .map((raise) => ({ raise, left: raise.extra }));
  if (pools.length === 0) return pools;
  const ordered = [...startedToday].sort(
    (a, b) => a.at - b.at || (a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0),
  );
  const seenByDeck = new Map<string, number>();
  for (const { card } of ordered) {
    const limit = state.decks.get(card.deck_id)?.settings.new_cards_per_day ?? 0;
    const seen = (seenByDeck.get(card.deck_id) ?? 0) + 1;
    seenByDeck.set(card.deck_id, seen);
    if (seen <= limit) continue;
    const pool = findRaisePool(state, pools, card, nowMs, tzOffsetMinutes, globalDayStart);
    if (pool) pool.left -= 1;
  }
  return pools;
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

/** Orders one deck's new-card candidates by `new_card_order` (`random` is stable per study day). */
function sortNewCandidates(
  state: CollectionState,
  candidates: Card[],
  order: string,
  day: { nowMs: number; tzOffsetMinutes: number; dayStart: number },
): void {
  if (order === 'random') {
    const todayIndex = getStudyDayIndex(day.nowMs, day.tzOffsetMinutes, day.dayStart);
    candidates.sort((a, b) => {
      const ha = hashString32(`${todayIndex}:${a.id}`);
      const hb = hashString32(`${todayIndex}:${b.id}`);
      return ha - hb || (a.id < b.id ? -1 : 1);
    });
    return;
  }
  // Source order: by note.created_order, then layout order (Recognition before Production), then id
  candidates.sort((a, b) => {
    const oa = state.notes.get(a.note_id)?.created_order ?? 0;
    const ob = state.notes.get(b.note_id)?.created_order ?? 0;
    if (oa !== ob) return oa - ob;
    if (a.layout_id !== b.layout_id) {
      const aIsRec = a.layout_id.includes('recognition') ? 0 : 1;
      const bIsRec = b.layout_id.includes('recognition') ? 0 : 1;
      if (aIsRec !== bIsRec) return aIsRec - bIsRec;
      return a.layout_id < b.layout_id ? -1 : 1;
    }
    if (a.variant !== b.variant) {
      return a.variant - b.variant;
    }
    return a.id < b.id ? -1 : 1;
  });
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
  const { deckId, nowMs, tzOffsetMinutes } = options;
  const globalDayStart = options.dayStartHour ?? state.preferences.day_start_hour;
  const allowedCardIds =
    options.filter !== undefined && !isCardFilterEmpty(options.filter)
      ? filterCardIds(state, options.filter, {
          nowMs,
          tzOffsetMinutes,
          ...(options.dayStartHour !== undefined ? { dayStartHour: options.dayStartHour } : {}),
          excludeSuspended: true,
        })
      : undefined;

  // Determine which notes already had a card reviewed today (for sibling burying)
  // AND count per-deck new/review quotas consumed today.
  const reviewedNoteIdsToday = new Set<string>();
  const reviewsTodayByDeck = new Map<string, number>();
  const newCardsStartedTodayByDeck = new Map<string, number>();
  const startedToday: Array<{ card: Card; at: number }> = [];

  for (const card of state.cards.values()) {
    const deck = state.decks.get(card.deck_id);
    if (!deck || deck.archived) continue;
    const dayStart = resolveDayStartHour(deck.settings.day_start_hour, globalDayStart);
    const todayIndex = getStudyDayIndex(nowMs, tzOffsetMinutes, dayStart);

    const reviews = state.reviewsByCard.get(card.id);
    if (!reviews || reviews.length === 0) continue;

    let firstActiveReviewTime = Infinity;
    let activeCountToday = 0;
    for (const r of reviews) {
      if (state.undoneReviewIds.has(r.review_id)) continue;
      if (r.reviewed_at < firstActiveReviewTime) {
        firstActiveReviewTime = r.reviewed_at;
      }
      const revDay = getStudyDayIndex(r.reviewed_at, tzOffsetMinutes, dayStart);
      if (revDay === todayIndex) {
        activeCountToday += 1;
      }
    }

    if (activeCountToday > 0) {
      reviewedNoteIdsToday.add(card.note_id);
      reviewsTodayByDeck.set(
        card.deck_id,
        (reviewsTodayByDeck.get(card.deck_id) ?? 0) + activeCountToday,
      );
      if (
        firstActiveReviewTime < Infinity &&
        getStudyDayIndex(firstActiveReviewTime, tzOffsetMinutes, dayStart) === todayIndex
      ) {
        newCardsStartedTodayByDeck.set(
          card.deck_id,
          (newCardsStartedTodayByDeck.get(card.deck_id) ?? 0) + 1,
        );
        startedToday.push({ card, at: firstActiveReviewTime });
      }
    }
  }

  // Group eligible cards into learning, due, new per deck
  const learningCards: Card[] = [];
  const dueCards: Card[] = [];
  const newCardsByDeck = new Map<string, Card[]>();
  const buriedNoteIds = new Set<string>();
  let nextLearningDueAt: number | undefined;

  for (const card of state.cards.values()) {
    if (deckId !== undefined && card.deck_id !== deckId) continue;
    if (allowedCardIds !== undefined && !allowedCardIds.has(card.id)) continue;
    if (isCardSuspended(state, card.id)) continue;
    const deck = state.decks.get(card.deck_id);
    if (!deck || deck.archived) continue;
    const note = state.notes.get(card.note_id);
    if (!note || note.archived) continue;

    const dayStart = resolveDayStartHour(deck.settings.day_start_hour, globalDayStart);
    const endOfTodayMs = getNextStudyDayRolloverMs(nowMs, tzOffsetMinutes, dayStart);

    const s = card.schedule;
    if (s.state === 1 || s.state === 3) {
      // Learning or Relearning: due now (or within current study day if already in learning step)
      // Note: a card already in learning today is NOT buried against itself; only siblings are buried
      const wasThisCardReviewedToday =
        card.last_reviewed_at !== undefined &&
        getStudyDayIndex(card.last_reviewed_at, tzOffsetMinutes, dayStart) ===
          getStudyDayIndex(nowMs, tzOffsetMinutes, dayStart);

      if (!wasThisCardReviewedToday && reviewedNoteIdsToday.has(card.note_id)) {
        buriedNoteIds.add(card.note_id);
        continue;
      }

      if (s.due <= nowMs) {
        learningCards.push(card);
      } else if (s.due < endOfTodayMs) {
        if (nextLearningDueAt === undefined || s.due < nextLearningDueAt) {
          nextLearningDueAt = s.due;
        }
      }
    } else if (s.state === 2) {
      // Review card
      if (reviewedNoteIdsToday.has(card.note_id)) {
        buriedNoteIds.add(card.note_id);
        continue;
      }
      if (s.due < endOfTodayMs) {
        dueCards.push(card);
      }
    } else {
      // New card (state === 0)
      if (reviewedNoteIdsToday.has(card.note_id)) {
        buriedNoteIds.add(card.note_id);
        continue;
      }
      const list = newCardsByDeck.get(card.deck_id) ?? [];
      list.push(card);
      newCardsByDeck.set(card.deck_id, list);
    }
  }

  // Sort learning by earliest due first
  learningCards.sort((a, b) => a.schedule.due - b.schedule.due || (a.id < b.id ? -1 : 1));
  // Sort due reviews by earliest due first
  dueCards.sort((a, b) => a.schedule.due - b.schedule.due || (a.id < b.id ? -1 : 1));

  // Enforce sibling burying within the queue itself (at most one card per note_id)
  const queuedNoteIds = new Set<string>();
  const finalLearning: Card[] = [];
  const finalDue: Card[] = [];
  const finalNew: Card[] = [];

  for (const card of learningCards) {
    if (queuedNoteIds.has(card.note_id)) {
      buriedNoteIds.add(card.note_id);
      continue;
    }
    queuedNoteIds.add(card.note_id);
    finalLearning.push(card);
  }

  // Apply per-deck max_reviews_per_day for due review cards
  const queuedDueByDeck = new Map<string, number>();
  for (const card of dueCards) {
    if (queuedNoteIds.has(card.note_id)) {
      buriedNoteIds.add(card.note_id);
      continue;
    }
    const deck = state.decks.get(card.deck_id);
    if (!deck) continue;
    const doneToday = reviewsTodayByDeck.get(card.deck_id) ?? 0;
    const queuedForDeck = queuedDueByDeck.get(card.deck_id) ?? 0;
    if (doneToday + queuedForDeck >= deck.settings.max_reviews_per_day) {
      continue;
    }
    queuedNoteIds.add(card.note_id);
    queuedDueByDeck.set(card.deck_id, queuedForDeck + 1);
    finalDue.push(card);
  }

  // Apply per-deck new_cards_per_day & new_card_order, then custom-study extra new cards
  const pools = openRaisePools(state, startedToday, nowMs, tzOffsetMinutes, globalDayStart);
  const deckIdsSorted = [...newCardsByDeck.keys()].sort();
  for (const dId of deckIdsSorted) {
    const deck = state.decks.get(dId);
    const candidates = newCardsByDeck.get(dId);
    if (!deck || !candidates) continue;
    let baseLeft = Math.max(
      0,
      deck.settings.new_cards_per_day - (newCardsStartedTodayByDeck.get(dId) ?? 0),
    );
    if (baseLeft === 0 && !pools.some((p) => p.left > 0)) continue;
    const dayStart = resolveDayStartHour(deck.settings.day_start_hour, globalDayStart);
    sortNewCandidates(state, candidates, deck.settings.new_card_order, {
      nowMs,
      tzOffsetMinutes,
      dayStart,
    });
    for (const card of candidates) {
      const pool =
        baseLeft > 0
          ? undefined
          : findRaisePool(state, pools, card, nowMs, tzOffsetMinutes, globalDayStart);
      if (baseLeft === 0 && pool === undefined) {
        if (!pools.some((p) => p.left > 0)) break;
        continue;
      }
      if (queuedNoteIds.has(card.note_id)) {
        buriedNoteIds.add(card.note_id);
        continue;
      }
      queuedNoteIds.add(card.note_id);
      finalNew.push(card);
      if (pool) pool.left -= 1;
      else baseLeft -= 1;
    }
  }

  const queue = [...finalLearning, ...finalDue, ...finalNew];
  const result: StudyQueueResult = {
    queue,
    counts: {
      new: finalNew.length,
      learning: finalLearning.length,
      due: finalDue.length,
      total: queue.length,
    },
    buriedNoteIds,
  };
  if (nextLearningDueAt !== undefined) {
    result.nextLearningDueAt = nextLearningDueAt;
  }
  return result;
}
