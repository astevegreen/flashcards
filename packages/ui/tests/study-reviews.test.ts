import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  isCardSuspended,
  LEECH_LAPSE_THRESHOLD,
  type Card,
  type CollectionState,
} from '@flash/core';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '@flash/core/samples';
import { describe, expect, it } from 'vitest';
import {
  planRedo,
  planReview,
  planUndo,
  pushUndoEntry,
  UNDO_STACK_LIMIT,
  type UndoEntry,
} from '../src/state/studyReviews.ts';

const DAY = 86_400_000;
const NOW = SAMPLE_SEED_EPOCH_MS + 10 * DAY;

function setup() {
  const factory = createEventFactory('dev', 0, createHlcState('dev', SAMPLE_SEED_EPOCH_MS));
  const state = applyEvents(
    createEmptyState(),
    buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS),
  );
  const card = [...state.cards.values()][0];
  if (!card) throw new Error('sample deck has no cards');
  return { factory, state, card };
}

const live = (st: CollectionState, card: Card): Card => {
  const c = st.cards.get(card.id);
  if (!c) throw new Error('card gone');
  return c;
};

describe('study answer, Undo and Redo (§9 UI state)', () => {
  it('rate, undo and redo round-trip the card schedule', () => {
    const { factory, state, card } = setup();
    const before = live(state, card).schedule;

    const rated = planReview(state, factory, card, 3, 1234.4, NOW, { typedAnswer: 'x' });
    expect(rated.events.map((e) => e.type)).toEqual(['ReviewRecorded']);
    expect(rated.entry).toMatchObject({ cardId: card.id, deckId: card.deck_id });
    expect(rated.entry.review).toMatchObject({ rating: 3, duration_ms: 1234, typed_answer: 'x' });
    applyEvents(state, rated.events);
    const after = live(state, card).schedule;
    expect(after.reps).toBe(before.reps + 1);

    const undo = planUndo(state, factory, [rated.entry], undefined, NOW + 1000);
    if (!undo || undo.stale) throw new Error('expected an undo');
    expect(undo.events.map((e) => e.type)).toEqual(['ReviewUndone']);
    applyEvents(state, undo.events);
    expect(live(state, card).schedule).toEqual(before);

    const redo = planRedo(state, factory, [undo.entry], undefined, NOW + 2000);
    if (!redo || redo.stale) throw new Error('expected a redo');
    expect(redo.entry.reviewId).not.toBe(rated.entry.reviewId);
    // Recorded again with its original time and answer, so the schedule comes back as it was.
    expect(redo.entry.review).toEqual({ ...rated.entry.review, review_id: redo.entry.reviewId });
    applyEvents(state, redo.events);
    expect(live(state, card).schedule).toEqual(after);
  });

  it('undoes and redoes the leech suspension and tag with the review', () => {
    const { factory, state, card } = setup();
    state.preferences = { ...state.preferences, leech_auto_suspend: true };
    const leechy: Card = {
      ...card,
      schedule: {
        ...card.schedule,
        state: 2,
        lapses: LEECH_LAPSE_THRESHOLD - 1,
        stability: 5,
        difficulty: 5,
        due: NOW,
        last_review: NOW - 5 * DAY,
      },
    };
    state.cards.set(card.id, leechy);

    const rated = planReview(state, factory, leechy, 1, 900, NOW);
    expect(rated.events.map((e) => e.type)).toEqual([
      'ReviewRecorded',
      'CardSuspended',
      'NoteTagsAdded',
    ]);
    expect(rated.entry).toMatchObject({ leechSuspended: true, leechTagged: true });
    applyEvents(state, rated.events);
    expect(isCardSuspended(state, card.id)).toBe(true);
    expect(state.notes.get(card.note_id)?.tags).toContain('leech');

    const undo = planUndo(state, factory, [rated.entry], card.deck_id, NOW + 1000);
    if (!undo || undo.stale) throw new Error('expected an undo');
    expect(undo.events.map((e) => e.type)).toEqual([
      'ReviewUndone',
      'CardUnsuspended',
      'NoteUpserted',
    ]);
    applyEvents(state, undo.events);
    expect(isCardSuspended(state, card.id)).toBe(false);
    expect(state.notes.get(card.note_id)?.tags).not.toContain('leech');

    const redo = planRedo(state, factory, [undo.entry], card.deck_id, NOW + 2000);
    if (!redo || redo.stale) throw new Error('expected a redo');
    expect(redo.events.map((e) => e.type)).toEqual([
      'ReviewRecorded',
      'CardSuspended',
      'NoteTagsAdded',
    ]);
    const suspended = redo.events[1];
    expect(suspended?.payload).toMatchObject({ review_id: redo.entry.reviewId, reason: 'leech' });
  });

  it('leaves other decks alone and drops entries a newer answer overtook', () => {
    const { factory, state, card } = setup();
    const rated = planReview(state, factory, card, 3, 1000, NOW);
    applyEvents(state, rated.events);
    expect(planUndo(state, factory, [], undefined, NOW)).toBeNull();
    expect(planUndo(state, factory, [rated.entry], 'another-deck', NOW)).toBeNull();

    // A newer review of the same card (say, synced from another device) stands.
    const newer = planReview(state, factory, live(state, card), 4, 1000, NOW + DAY);
    applyEvents(state, newer.events);
    expect(planUndo(state, factory, [rated.entry], undefined, NOW + DAY)).toEqual({ stale: true });
    expect(planRedo(state, factory, [rated.entry], undefined, NOW + DAY)).toEqual({ stale: true });
    expect(planRedo(state, factory, [rated.entry], 'another-deck', NOW + DAY)).toBeNull();

    // A card that is gone can't be redone.
    const gone = createEmptyState();
    expect(planRedo(gone, factory, [newer.entry], undefined, NOW + DAY)).toEqual({ stale: true });
  });

  it('keeps the newest 50 entries', () => {
    let stack: UndoEntry[] = [];
    for (let i = 0; i < UNDO_STACK_LIMIT + 5; i++) {
      stack = pushUndoEntry(stack, { reviewId: `r${i}` } as UndoEntry);
    }
    expect(stack).toHaveLength(UNDO_STACK_LIMIT);
    expect(stack[0]?.reviewId).toBe('r5');
    expect(stack.at(-1)?.reviewId).toBe(`r${UNDO_STACK_LIMIT + 4}`);
  });
});
