/** The P2 study-queue fixture: a large review collection built without replaying its history. */
import {
  createEventFactory,
  replayAllEvents,
  type CollectionState,
} from '../../src/events/replay.ts';
import type { KnownEvent } from '../../src/events/types.ts';
import { createHlcState } from '../../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../../src/ids.ts';
import type { ReviewRecord } from '../../src/model/types.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../../src/model/presets.ts';

export const DAY = 86_400_000;
export const PAST_REVIEWS_PER_CARD = 10;
export const REVIEWED_TODAY = 100;
export const REVIEW_LIMIT = 9999;
const LAYOUT_ID = 'layout:vocab-ko:recognition';
/** Noon UTC, well clear of the 04:00 rollover. */
export const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

/** `Map.get` calls on `reviewsByCard`, the per-card history walk P2 is about. */
export class CountingMap<K, V> extends Map<K, V> {
  gets = 0;
  override get(key: K): V | undefined {
    this.gets += 1;
    return super.get(key);
  }
}

/**
 * `cards` review cards with ten past reviews each, 100 of them also reviewed today and `dueToday`
 * of the others due today. The reviews are written into the state directly (as replay leaves
 * them), so even 20k cards build in well under a second without replaying 200k events.
 */
export function buildLargeCollection(
  cards: number,
  dueToday: number,
  reviewLimit = REVIEW_LIMIT,
): {
  state: CollectionState;
  reviews: CountingMap<string, ReviewRecord[]>;
} {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', NOW - 400 * DAY));
  const deckId = 'deck-perf';
  const events: KnownEvent[] = [
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: 'Perf',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: NOW - 400 * DAY,
      },
      NOW - 400 * DAY,
    ),
    factory.create(
      'DeckSettingsChanged',
      { deck_id: deckId, settings: { max_reviews_per_day: reviewLimit } },
      NOW - 400 * DAY,
    ),
  ];
  for (let i = 0; i < cards; i++) {
    events.push(
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(deckId, `n${i}`),
          deck_id: deckId,
          source_key: `n${i}`,
          fields: { word: `w${i}`, meaning: `m${i}` },
          tags: [],
        },
        NOW - 400 * DAY,
      ),
    );
  }
  const state = replayAllEvents(events);
  const reviews = new CountingMap<string, ReviewRecord[]>();
  for (let i = 0; i < cards; i++) {
    const cardId = deriveCardId(deriveNoteId(deckId, `n${i}`), LAYOUT_ID, 0);
    const list: ReviewRecord[] = [];
    for (let r = 0; r < PAST_REVIEWS_PER_CARD; r++) {
      list.push(reviewOf(cardId, `rev-${i}-${r}`, NOW - (PAST_REVIEWS_PER_CARD - r + 1) * DAY));
    }
    if (i < REVIEWED_TODAY) list.push(reviewOf(cardId, `rev-${i}-today`, NOW - 3_600_000));
    reviews.set(cardId, list);
    const card = state.cards.get(cardId);
    if (!card) throw new Error(`missing card ${cardId}`);
    // As replay sets it: the latest active review.
    const lastReviewedAt = Math.max(...list.map((r) => r.reviewed_at));
    state.cards.set(cardId, {
      ...card,
      schedule: { ...card.schedule, state: 2, due: dueAt(i, dueToday) },
      last_reviewed_at: lastReviewedAt,
      last_reviewed_tz_offset: 0,
    });
  }
  state.reviewsByCard = reviews;
  return { state, reviews };
}

function reviewOf(cardId: string, reviewId: string, at: number): ReviewRecord {
  return {
    review_id: reviewId,
    card_id: cardId,
    rating: 3,
    reviewed_at: at,
    tz_offset: 0,
    duration_ms: 1000,
    answer_mode: 'flip',
    fsrs_params_version: 0,
    resulting_due_at: NOW,
    hlc: reviewId,
  };
}

/** Cards reviewed today are due tomorrow; the next `dueToday` are overdue; the rest next month. */
function dueAt(i: number, dueToday: number): number {
  if (i < REVIEWED_TODAY) return NOW + DAY;
  return i < REVIEWED_TODAY + dueToday ? NOW - DAY : NOW + 30 * DAY;
}
