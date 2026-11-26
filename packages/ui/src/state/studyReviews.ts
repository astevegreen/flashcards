import {
  applyReviewToSchedule,
  getActiveFsrsParamsVersion,
  planLeechTag,
  planLeechTagUndo,
  resolveDeckFsrsConfig,
  shouldAutoSuspendLeech,
  uuidv7,
  type Card,
  type CollectionState,
  type EventFactory,
  type KnownEvent,
  type NoteTagsAddedPayload,
  type ReviewRating,
  type ReviewRecordedPayload,
} from '@flash/core';
import { hasNewerReview, inStudyScope } from './undoGuard.ts';

/**
 * What a study answer, its Undo and its Redo emit, decided from the collection alone. AppProvider
 * keeps the stacks and emits the events; these functions hold the rules, so they are tested
 * without rendering anything (§9).
 */

export interface UndoEntry {
  reviewId: string;
  cardId: string;
  deckId: string;
  /** The review made the card a leech and auto-suspended it; Undo unsuspends it too. */
  leechSuspended?: boolean;
  /** The review made the card a leech and tagged its note `leech`; Undo removes the tag. */
  leechTagged?: boolean;
  /** The review as recorded, so Redo can record it again after an Undo. */
  review: ReviewRecordedPayload;
  /** The `leech` tag add the review made, re-added by Redo. */
  tagAdd?: NoteTagsAddedPayload;
}

/** Undo and Redo each keep the newest 50 entries. */
export const UNDO_STACK_LIMIT = 50;

export function pushUndoEntry(stack: readonly UndoEntry[], entry: UndoEntry): UndoEntry[] {
  return [...stack.slice(-(UNDO_STACK_LIMIT - 1)), entry];
}

/** The review of `card` rated `rating` at `nowMs`, with the leech events it triggers. */
export function planReview(
  st: CollectionState,
  factory: EventFactory,
  card: Card,
  rating: ReviewRating,
  durationMs: number,
  nowMs: number,
  options?: { typedAnswer?: string },
): { events: KnownEvent[]; entry: UndoEntry } {
  const tzOffset = -new Date(nowMs).getTimezoneOffset();
  const paramsVersion = getActiveFsrsParamsVersion(st, card.deck_id);
  const fsrsConfig = resolveDeckFsrsConfig(st, card.deck_id, nowMs, paramsVersion);
  const { next, resulting_due_at } = applyReviewToSchedule(
    card.schedule,
    rating,
    nowMs,
    fsrsConfig,
  );
  const reviewId = uuidv7(nowMs);
  const layout = st.layouts.get(card.layout_id);

  const review: ReviewRecordedPayload = {
    review_id: reviewId,
    card_id: card.id,
    rating,
    reviewed_at: nowMs,
    tz_offset: tzOffset,
    duration_ms: Math.max(0, Math.round(durationMs)),
    answer_mode: layout?.answer_mode ?? 'flip',
    ...(options?.typedAnswer !== undefined ? { typed_answer: options.typedAnswer } : {}),
    fsrs_params_version: paramsVersion,
    resulting_due_at,
  };
  const events: KnownEvent[] = [factory.create('ReviewRecorded', review, nowMs)];

  // Phase 9 leech auto-suspend (setting, default off): decided once here, logged as an event.
  const leech = shouldAutoSuspendLeech(st, card.id, card.schedule.lapses, next.lapses);
  if (leech) {
    events.push(
      factory.create(
        'CardSuspended',
        { card_id: card.id, reason: 'leech', review_id: reviewId },
        nowMs,
      ),
    );
  }
  // Reaching the leech threshold tags the note `leech` (always, independent of auto-suspend).
  const leechTag = planLeechTag(st, card, card.schedule.lapses, next.lapses);
  if (leechTag) events.push(factory.create('NoteTagsAdded', leechTag, nowMs));
  const entry: UndoEntry = {
    reviewId,
    cardId: card.id,
    deckId: card.deck_id,
    ...(leech && { leechSuspended: true }),
    ...(leechTag && { leechTagged: true, tagAdd: leechTag }),
    review,
  };
  return { events, entry };
}

/**
 * Undo of the newest entry: `null` when there is nothing to undo in this deck; `stale` when a
 * newer answer (synced from another device) stands, so the entry is dropped and nothing undone.
 */
export function planUndo(
  st: CollectionState,
  factory: EventFactory,
  undoStack: readonly UndoEntry[],
  activeDeckId: string | undefined,
  nowMs: number,
): null | { stale: true } | { stale: false; events: KnownEvent[]; entry: UndoEntry } {
  const last = undoStack[undoStack.length - 1];
  if (!last || !inStudyScope(last, activeDeckId)) return null;
  if (hasNewerReview(st, last)) return { stale: true };
  const events: KnownEvent[] = [
    factory.create('ReviewUndone', { review_id: last.reviewId }, nowMs),
  ];
  if (last.leechSuspended) {
    events.push(factory.create('CardUnsuspended', { card_id: last.cardId }, nowMs));
  }
  const card = last.leechTagged ? st.cards.get(last.cardId) : undefined;
  const untag = card && planLeechTagUndo(st, card);
  if (untag) events.push(factory.create('NoteUpserted', untag, nowMs));
  return { stale: false, events, entry: last };
}

/**
 * Redo records the undone review again under a new id, with its original time and answer, so
 * replay gives the card the schedule it had before the Undo. `null` when there is nothing to redo
 * in this deck; `stale` (the entry is dropped) once the card is gone or has a newer review, e.g.
 * synced from another device, which the old one would now precede.
 */
export function planRedo(
  st: CollectionState,
  factory: EventFactory,
  redoStack: readonly UndoEntry[],
  activeDeckId: string | undefined,
  nowMs: number,
): null | { stale: true } | { stale: false; events: KnownEvent[]; entry: UndoEntry } {
  const last = redoStack[redoStack.length - 1];
  if (!last || !inStudyScope(last, activeDeckId)) return null;
  if (!st.cards.has(last.cardId) || hasNewerReview(st, last)) return { stale: true };
  const review: ReviewRecordedPayload = { ...last.review, review_id: uuidv7(nowMs) };
  const events: KnownEvent[] = [factory.create('ReviewRecorded', review, nowMs)];
  if (last.leechSuspended) {
    events.push(
      factory.create(
        'CardSuspended',
        { card_id: last.cardId, reason: 'leech', review_id: review.review_id },
        nowMs,
      ),
    );
  }
  if (last.tagAdd) events.push(factory.create('NoteTagsAdded', last.tagAdd, nowMs));
  return { stale: false, events, entry: { ...last, reviewId: review.review_id, review } };
}
