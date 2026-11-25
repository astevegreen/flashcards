import { createEmptyState, type CollectionState } from '@flash/core';
import { describe, expect, it } from 'vitest';
import { hasNewerReview, inStudyScope, type UndoTarget } from '../src/state/undoGuard.ts';

const entry: UndoTarget = { cardId: 'c1', deckId: 'd1', review: { reviewed_at: 1000 } };

function stateWithReviews(reviews: Array<{ id: string; at: number }>, undone: string[] = []) {
  const st: CollectionState = createEmptyState();
  st.reviewsByCard.set(
    'c1',
    reviews.map((r) => ({ review_id: r.id, reviewed_at: r.at }) as never),
  );
  for (const id of undone) st.undoneReviewIds.add(id);
  return st;
}

describe('study undo guards (C8)', () => {
  it('keeps Undo and Redo to the deck being studied', () => {
    expect(inStudyScope(entry, 'd1')).toBe(true);
    expect(inStudyScope(entry, undefined)).toBe(true);
    expect(inStudyScope(entry, 'd2')).toBe(false);
  });

  it('refuses an entry once the card has a newer active review', () => {
    expect(hasNewerReview(stateWithReviews([{ id: 'r1', at: 1000 }]), entry)).toBe(false);
    expect(
      hasNewerReview(
        stateWithReviews([
          { id: 'r1', at: 1000 },
          { id: 'r2', at: 2000 },
        ]),
        entry,
      ),
    ).toBe(true);
    // An undone newer review doesn't count.
    expect(
      hasNewerReview(
        stateWithReviews(
          [
            { id: 'r1', at: 1000 },
            { id: 'r2', at: 2000 },
          ],
          ['r2'],
        ),
        entry,
      ),
    ).toBe(false);
  });
});
