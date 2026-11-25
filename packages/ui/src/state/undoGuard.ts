import type { CollectionState } from '@flash/core';

/** What the study Undo and Redo stacks hold for each review (C8). */
export interface UndoTarget {
  cardId: string;
  deckId: string;
  review: { reviewed_at: number };
}

/**
 * The entry belongs to the deck being studied, or every deck is (C8). Undo and Redo leave entries
 * of other decks alone, so they never change a card the user can't see; switching back to that
 * deck makes them available again.
 */
export function inStudyScope(entry: UndoTarget, activeDeckId: string | undefined): boolean {
  return activeDeckId === undefined || entry.deckId === activeDeckId;
}

/**
 * The card has an active review newer than this one, for example synced from another device.
 * Undoing (or redoing) the older one would then rewrite history under the newer answer (C8).
 */
export function hasNewerReview(st: CollectionState, entry: UndoTarget): boolean {
  return (st.reviewsByCard.get(entry.cardId) ?? []).some(
    (r) => !st.undoneReviewIds.has(r.review_id) && r.reviewed_at > entry.review.reviewed_at,
  );
}
