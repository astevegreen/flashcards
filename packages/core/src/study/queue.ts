import type { CollectionState } from '../events/replay.ts';
import { getNextStudyDayRolloverMs, getStudyDayIndex } from '../fsrs/scheduler.ts';
import type { Card } from '../model/types.ts';

export interface StudyQueueOptions {
  deckId?: string;
  nowMs: number;
  /** Minutes east of UTC (e.g., `-new Date().getTimezoneOffset()`). */
  tzOffsetMinutes: number;
  /** Optional override for study day rollover hour (defaults to state.preferences.day_start_hour = 4). */
  dayStartHour?: number;
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

/**
 * Builds today's study queue for a deck or the whole collection.
 * Enforces:
 * - Study-day rollover (default 04:00 local time)
 * - Per-deck `new_cards_per_day` & `max_reviews_per_day`
 * - `new_card_order` (`source` | `random`)
 * - Sibling burying (§5.1): if one card of a `note_id` was reviewed today (or is queued),
 *   sibling cards of the same note are buried until the next study day.
 */
export function buildStudyQueue(
  state: CollectionState,
  options: StudyQueueOptions,
): StudyQueueResult {
  const { deckId, nowMs, tzOffsetMinutes } = options;
  const globalDayStart = options.dayStartHour ?? state.preferences.day_start_hour;

  // Determine which notes already had a card reviewed today (for sibling burying)
  // AND count per-deck new/review quotas consumed today.
  const reviewedNoteIdsToday = new Set<string>();
  const reviewsTodayByDeck = new Map<string, number>();
  const newCardsStartedTodayByDeck = new Map<string, number>();

  for (const card of state.cards.values()) {
    const deck = state.decks.get(card.deck_id);
    if (!deck || deck.archived) continue;
    const dayStart = deck.settings.day_start_hour ?? globalDayStart;
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
    const deck = state.decks.get(card.deck_id);
    if (!deck || deck.archived) continue;
    const note = state.notes.get(card.note_id);
    if (!note || note.archived) continue;

    const dayStart = deck.settings.day_start_hour ?? globalDayStart;
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

  // Apply per-deck new_cards_per_day & new_card_order
  const deckIdsSorted = [...newCardsByDeck.keys()].sort();
  for (const dId of deckIdsSorted) {
    const deck = state.decks.get(dId);
    if (!deck) continue;
    const dayStart = deck.settings.day_start_hour ?? globalDayStart;
    const todayIndex = getStudyDayIndex(nowMs, tzOffsetMinutes, dayStart);
    const alreadyStarted = newCardsStartedTodayByDeck.get(dId) ?? 0;
    const remainingNewQuota = Math.max(0, deck.settings.new_cards_per_day - alreadyStarted);
    if (remainingNewQuota === 0) continue;

    const candidates = newCardsByDeck.get(dId);
    if (!candidates) continue;
    if (deck.settings.new_card_order === 'random') {
      candidates.sort((a, b) => {
        const ha = hashString32(`${todayIndex}:${a.id}`);
        const hb = hashString32(`${todayIndex}:${b.id}`);
        return ha - hb || (a.id < b.id ? -1 : 1);
      });
    } else {
      // Source order: by note.created_order, then layout order (Recognition before Production), then id
      candidates.sort((a, b) => {
        const na = state.notes.get(a.note_id);
        const nb = state.notes.get(b.note_id);
        const oa = na?.created_order ?? 0;
        const ob = nb?.created_order ?? 0;
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

    let taken = 0;
    for (const card of candidates) {
      if (taken >= remainingNewQuota) break;
      if (queuedNoteIds.has(card.note_id)) {
        buriedNoteIds.add(card.note_id);
        continue;
      }
      queuedNoteIds.add(card.note_id);
      finalNew.push(card);
      taken += 1;
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
