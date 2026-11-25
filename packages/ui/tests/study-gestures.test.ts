import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canVerticalSwipeFromScroll,
  classifySwipe,
  nextRevealStep,
  resolveStudyKeyAction,
  revealHint,
  SWIPE_INTENT_LABEL,
  SWIPE_RATING,
  type StudyKeyEventLike,
} from '../src/study/studyGestures.ts';
import {
  isTouchDevice,
  readSwipeGuideDismissed,
  shouldShowSwipeGuide,
  storeSwipeGuideDismissed,
  SWIPE_GUIDE_DISMISSED_KEY,
} from '../src/study/swipeGuide.ts';

function keyEvent(key: string, overrides: Partial<StudyKeyEventLike> = {}): StudyKeyEventLike {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    ...overrides,
  };
}

function stubStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe('classifySwipe', () => {
  it('maps LEFT=good, RIGHT=back, DOWN=again, UP=easy in 3/4-button modes', () => {
    expect(classifySwipe(-90, 0, '3', 72, 80)).toBe('good');
    expect(classifySwipe(90, 0, '3', 72, 80)).toBe('back');
    expect(classifySwipe(0, 95, '3', 72, 80)).toBe('again');
    expect(classifySwipe(0, -95, '3', 72, 80)).toBe('easy');
    expect(classifySwipe(0, -95, '4', 72, 80)).toBe('easy');
  });

  it('maps UP=good when rating mode is 2-button', () => {
    expect(classifySwipe(0, -95, '2', 72, 80)).toBe('good');
    expect(classifySwipe(-90, 0, '2', 72, 80)).toBe('good');
    expect(classifySwipe(0, 95, '2', 72, 80)).toBe('again');
    expect(classifySwipe(90, 0, '2', 72, 80)).toBe('back');
  });

  it('returns null below threshold and prefers dominant axis', () => {
    expect(classifySwipe(-50, 10, '3', 72, 80)).toBeNull();
    expect(classifySwipe(10, 60, '3', 72, 80)).toBeNull();
    expect(classifySwipe(-100, 85, '3', 72, 80)).toBe('good');
    expect(classifySwipe(-80, 100, '3', 72, 80)).toBe('again');
  });

  it('maps rating intents to FSRS ratings and human-readable labels', () => {
    expect(SWIPE_RATING).toEqual({ again: 1, good: 3, easy: 4 });
    expect(SWIPE_INTENT_LABEL).toEqual({
      good: 'Good',
      again: 'Again',
      easy: 'Easy',
      back: 'Back',
    });
  });
});

describe('nextRevealStep & revealHint', () => {
  it('cycles front -> step 1 -> step 2 -> ... -> last -> back to step 1', () => {
    expect(nextRevealStep(0, 2)).toBe(1);
    expect(nextRevealStep(1, 2)).toBe(2);
    expect(nextRevealStep(2, 2)).toBe(1);

    expect(nextRevealStep(0, 3)).toBe(1);
    expect(nextRevealStep(1, 3)).toBe(2);
    expect(nextRevealStep(2, 3)).toBe(3);
    expect(nextRevealStep(3, 3)).toBe(1);

    expect(nextRevealStep(0, 1)).toBe(1);
    expect(nextRevealStep(1, 1)).toBe(1);
    expect(nextRevealStep(0, 0)).toBe(0);
  });

  it('shows appropriate hints for front, intermediate, and final steps', () => {
    expect(revealHint(false, false, 2, false)).toBe('Tap card or press Space to reveal');
    expect(revealHint(false, false, 2, true)).toBeNull();
    expect(revealHint(true, false, 2, false)).toBe('Tap for more •••');
    expect(revealHint(true, true, 2, false)).toBe('Tap to return to answer');
    expect(revealHint(true, true, 1, false)).toBeNull();
  });
});

describe('canVerticalSwipeFromScroll', () => {
  it('always allows vertical swipe when content fits without overflow', () => {
    expect(canVerticalSwipeFromScroll(50, 0, 300, 300)).toBe(true);
    expect(canVerticalSwipeFromScroll(-50, 0, 300, 300)).toBe(true);
  });

  it('allows downward swipe only at top edge and upward swipe only at bottom edge when overflowing', () => {
    // At top of overflowing container
    expect(canVerticalSwipeFromScroll(40, 0, 600, 300)).toBe(true);
    expect(canVerticalSwipeFromScroll(-40, 0, 600, 300)).toBe(false);
    // In the middle
    expect(canVerticalSwipeFromScroll(40, 120, 600, 300)).toBe(false);
    expect(canVerticalSwipeFromScroll(-40, 120, 600, 300)).toBe(false);
    // At the bottom
    expect(canVerticalSwipeFromScroll(40, 300, 600, 300)).toBe(false);
    expect(canVerticalSwipeFromScroll(-40, 300, 600, 300)).toBe(true);
  });
});

describe('resolveStudyKeyAction', () => {
  it('ignores key auto-repeat so holding a key never rates or undoes more than once (C1)', () => {
    const held = { repeat: true };
    for (const key of ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight', '2', 'z', ' ']) {
      expect(resolveStudyKeyAction(keyEvent(key, held), true, false, '4')).toBeUndefined();
    }
    expect(
      resolveStudyKeyAction(keyEvent('z', { ...held, ctrlKey: true }), true, false, '4'),
    ).toBeUndefined();
    expect(resolveStudyKeyAction(keyEvent('2', { repeat: false }), true, false, '4')).toEqual({
      type: 'rate',
      rating: 3,
      allowUnrevealed: false,
    });
  });

  it('leaves arrow keys to a control that has keyboard focus, so D-pad navigation works (C3)', () => {
    // Stands in for a DOM element: `matches` answers the control selector and `:focus-visible`.
    const element = (control: boolean, focusVisible: boolean) => ({
      matches: (selector: string) => (selector === ':focus-visible' ? focusVisible : control),
    });
    const at = (key: string, target: unknown) =>
      resolveStudyKeyAction(keyEvent(key, { target: target as EventTarget }), true, false, '4');
    const filterButtonViaDpad = element(true, true);
    for (const key of ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight']) {
      expect(at(key, filterButtonViaDpad)).toBeUndefined();
    }
    // Number keys still rate from anywhere.
    expect(at('2', filterButtonViaDpad)).toEqual({
      type: 'rate',
      rating: 3,
      allowUnrevealed: false,
    });
    // A button that was clicked keeps focus without :focus-visible; arrows still rate there.
    expect(at('ArrowLeft', element(true, false))).toEqual({
      type: 'rate',
      rating: 3,
      allowUnrevealed: true,
    });
    // Focus on the card body (not a control) rates as before.
    expect(at('ArrowDown', element(false, true))).toEqual({
      type: 'rate',
      rating: 1,
      allowUnrevealed: true,
    });
    // A WebView without :focus-visible support: a focused control keeps its arrows.
    const oldWebView = {
      matches: (selector: string) => {
        if (selector === ':focus-visible') throw new SyntaxError('unsupported');
        return true;
      },
    };
    expect(at('ArrowLeft', oldWebView)).toBeUndefined();
  });

  it('maps arrow keys with swipe parity (left=Good, down=Again, up=Easy/Good, right=Undo)', () => {
    expect(resolveStudyKeyAction(keyEvent('ArrowLeft'), true, false, '3')).toEqual({
      type: 'rate',
      rating: 3,
      allowUnrevealed: true,
    });
    expect(resolveStudyKeyAction(keyEvent('ArrowDown'), true, false, '3')).toEqual({
      type: 'rate',
      rating: 1,
      allowUnrevealed: true,
    });
    expect(resolveStudyKeyAction(keyEvent('ArrowUp'), true, false, '3')).toEqual({
      type: 'rate',
      rating: 4,
      allowUnrevealed: true,
    });
    expect(resolveStudyKeyAction(keyEvent('ArrowUp'), true, false, '2')).toEqual({
      type: 'rate',
      rating: 3,
      allowUnrevealed: true,
    });
    expect(resolveStudyKeyAction(keyEvent('ArrowRight'), false, false, '3')).toBe('undo');
  });

  it('allows arrow ratings on flip-style front, but blocks them on interactive front', () => {
    expect(resolveStudyKeyAction(keyEvent('ArrowLeft'), false, false, '3')).toEqual({
      type: 'rate',
      rating: 3,
      allowUnrevealed: true,
    });
    expect(resolveStudyKeyAction(keyEvent('ArrowLeft'), false, true, '3')).toBeUndefined();
    expect(resolveStudyKeyAction(keyEvent('ArrowDown'), false, true, '3')).toBeUndefined();
    expect(resolveStudyKeyAction(keyEvent('ArrowUp'), false, true, '3')).toBeUndefined();
    // ArrowRight (undo) still works
    expect(resolveStudyKeyAction(keyEvent('ArrowRight'), false, true, '3')).toBe('undo');
  });

  it('keeps number keys 1-4 unchanged and gated on reveal + rating mode', () => {
    expect(resolveStudyKeyAction(keyEvent('1'), false, false, '4')).toBeUndefined();
    expect(resolveStudyKeyAction(keyEvent('1'), true, false, '3')).toEqual({
      type: 'rate',
      rating: 1,
      allowUnrevealed: false,
    });
    expect(resolveStudyKeyAction(keyEvent('2'), true, false, '3')).toEqual({
      type: 'rate',
      rating: 3,
      allowUnrevealed: false,
    });
    expect(resolveStudyKeyAction(keyEvent('3'), true, false, '3')).toEqual({
      type: 'rate',
      rating: 4,
      allowUnrevealed: false,
    });
    expect(resolveStudyKeyAction(keyEvent('3'), true, false, '2')).toBeUndefined();
    expect(resolveStudyKeyAction(keyEvent('4'), true, false, '3')).toBeUndefined();
    expect(resolveStudyKeyAction(keyEvent('4'), true, false, '4')).toEqual({
      type: 'rate',
      rating: 2,
      allowUnrevealed: false,
    });
  });

  it('keeps Space and Enter cycling reveal steps even after fully revealed', () => {
    expect(resolveStudyKeyAction(keyEvent(' '), false, false, '3')).toBe('reveal');
    expect(resolveStudyKeyAction(keyEvent(' '), true, false, '3')).toBe('reveal');
    expect(resolveStudyKeyAction(keyEvent('Enter'), true, false, '3')).toBe('reveal');
    expect(resolveStudyKeyAction(keyEvent(' '), false, true, '3')).toBeUndefined();
  });
});

describe('swipe guide (device-local)', () => {
  it('stores and reads dismissal safely in localStorage', () => {
    const data = stubStorage();
    expect(readSwipeGuideDismissed()).toBe(false);
    storeSwipeGuideDismissed(true);
    expect(data.get(SWIPE_GUIDE_DISMISSED_KEY)).toBe('1');
    expect(readSwipeGuideDismissed()).toBe(true);
    storeSwipeGuideDismissed(false);
    expect(readSwipeGuideDismissed()).toBe(false);
  });

  it('shows only on touch devices until dismissed', () => {
    stubStorage();
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: true }),
    });
    expect(isTouchDevice()).toBe(true);
    expect(shouldShowSwipeGuide()).toBe(true);

    storeSwipeGuideDismissed(true);
    expect(shouldShowSwipeGuide()).toBe(false);
  });

  it('stays hidden on non-touch devices', () => {
    stubStorage();
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    expect(isTouchDevice()).toBe(false);
    expect(shouldShowSwipeGuide()).toBe(false);
  });
});
