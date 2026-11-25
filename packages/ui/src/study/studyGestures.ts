import type { RatingButtonMode, ReviewRating } from '@flash/core';

export type SwipeIntent = 'again' | 'good' | 'easy' | 'back' | null;

export type SwipeRatingIntent = Exclude<SwipeIntent, null | 'back'>;

export const SWIPE_RATING: Readonly<Record<SwipeRatingIntent, ReviewRating>> = {
  again: 1,
  good: 3,
  easy: 4,
};

export const SWIPE_INTENT_LABEL: Readonly<Record<Exclude<SwipeIntent, null>, string>> = {
  good: 'Good',
  again: 'Again',
  easy: 'Easy',
  back: 'Back',
};

/**
 * Classify a pointer drag past the given thresholds (px), or `null`.
 *
 * Mapping:
 * - LEFT (`dx < 0`) = Good (3)
 * - RIGHT (`dx > 0`) = Back (undo previous card)
 * - DOWN (`dy > 0`) = Again (1)
 * - UP (`dy < 0`) = Easy (4), or Good (3) when rating mode is `'2'`
 */
export function classifySwipe(
  dx: number,
  dy: number,
  ratingMode: RatingButtonMode,
  minX: number,
  minY: number,
): SwipeIntent {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX >= minX && absX > absY) return dx < 0 ? 'good' : 'back';
  if (absY >= minY && absY > absX) {
    if (dy > 0) return 'again';
    return ratingMode === '2' ? 'good' : 'easy';
  }
  return null;
}

/**
 * Advance the reveal step, cycling `0 -> 1 -> 2 -> ... -> totalSteps -> 1` so tapping
 * (or Space/Enter) keeps flipping through the card's sides without requiring a rating.
 */
export function nextRevealStep(current: number, totalSteps: number): number {
  if (totalSteps <= 0) return 0;
  if (current < totalSteps) return current + 1;
  return 1;
}

/** Subtle hint shown inside the card body for tap/Space reveal cycling. */
export function revealHint(
  isRevealed: boolean,
  isFullyRevealed: boolean,
  totalRevealSteps: number,
  capturesFront: boolean,
): string | null {
  if (!isRevealed) {
    return capturesFront ? null : 'Tap card or press Space to reveal';
  }
  if (!isFullyRevealed) return 'Tap for more •••';
  if (totalRevealSteps > 1) return 'Tap to return to answer';
  return null;
}

/**
 * Whether a vertical drag (`dy`) starting inside a scroll container should be treated as a
 * card swipe instead of scrolling the container.
 *
 * - Non-overflowing container: always allowed.
 * - Overflowing container: only when dragging outward from the top (`dy > 0` at top edge)
 *   or bottom (`dy < 0` at bottom edge).
 */
export function canVerticalSwipeFromScroll(
  dy: number,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  if (scrollHeight <= clientHeight + 1) return true;
  if (dy > 0) return scrollTop <= 1;
  if (dy < 0) return scrollTop + clientHeight >= scrollHeight - 1;
  return false;
}

export type StudyKeyAction =
  | 'undo'
  | 'redo'
  | 'reveal'
  | 'furigana'
  | 'speak'
  | 'slow'
  | 'edit'
  | { readonly type: 'rate'; readonly rating: ReviewRating; readonly allowUnrevealed: boolean };

const LETTER_KEY_ACTIONS: Readonly<
  Record<string, 'furigana' | 'speak' | 'slow' | 'undo' | 'edit'>
> = {
  f: 'furigana',
  r: 'speak',
  s: 'slow',
  z: 'undo',
  e: 'edit',
};

/** Number-key rating shortcuts: [rating, minimum rating button count] (§5.1). */
const NUMBER_RATING_KEYS: Readonly<Record<string, readonly [ReviewRating, number]>> = {
  '1': [1, 0],
  '2': [3, 0],
  '3': [4, 3],
  '4': [2, 4],
};

function isButtonOrLink(target: EventTarget | null): boolean {
  if (typeof HTMLButtonElement !== 'undefined' && target instanceof HTMLButtonElement) return true;
  if (typeof HTMLAnchorElement !== 'undefined' && target instanceof HTMLAnchorElement) return true;
  return false;
}

/** Space / Enter cycle reveal steps, unless focus is on a button/link or interactive front. */
function confirmKeyAction(
  target: EventTarget | null,
  isRevealed: boolean,
  capturesFront: boolean,
): StudyKeyAction | undefined {
  if (isButtonOrLink(target)) return undefined;
  if (!isRevealed && capturesFront) return undefined;
  return 'reveal';
}

export interface StudyKeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Key auto-repeat: never acted on, so holding a key can't rate unseen cards (C1). */
  repeat?: boolean;
  target: EventTarget | null;
}

/**
 * Desktop keyboard shortcuts (§5.1 & §5.2).
 *
 * Arrow keys match swipe gestures:
 * - `ArrowLeft` = Good (3)
 * - `ArrowDown` = Again (1)
 * - `ArrowUp` = Easy (4), or Good (3) in 2-button mode
 * - `ArrowRight` = Undo / previous card
 */
export function resolveStudyKeyAction(
  e: StudyKeyEventLike,
  isRevealed: boolean,
  capturesFront: boolean,
  ratingMode: RatingButtonMode,
): StudyKeyAction | undefined {
  if (e.repeat) return undefined;
  const key = e.key;
  if (e.ctrlKey || e.metaKey) {
    const lower = key.toLowerCase();
    if ((lower === 'z' && e.shiftKey) || (lower === 'y' && !e.shiftKey)) return 'redo';
    if (lower === 'z') return 'undo';
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  if (key === ' ' || key === 'Enter') return confirmKeyAction(e.target, isRevealed, capturesFront);

  const letter = LETTER_KEY_ACTIONS[key.toLowerCase()];
  if (letter !== undefined) return letter;

  // Arrow keys mirror swipe directions (and work on flip-style fronts too).
  if (key === 'ArrowRight') return 'undo';
  if (isRevealed || !capturesFront) {
    if (key === 'ArrowLeft') return { type: 'rate', rating: 3, allowUnrevealed: true };
    if (key === 'ArrowDown') return { type: 'rate', rating: 1, allowUnrevealed: true };
    if (key === 'ArrowUp') {
      return { type: 'rate', rating: ratingMode === '2' ? 3 : 4, allowUnrevealed: true };
    }
  }

  const num = isRevealed ? NUMBER_RATING_KEYS[key] : undefined;
  if (num && Number(ratingMode) >= num[1]) {
    return { type: 'rate', rating: num[0], allowUnrevealed: false };
  }
  return undefined;
}
