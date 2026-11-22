import type { RatingButtonMode, ReviewRating } from '@flash/core';
import { useLayoutEffect, useRef } from 'react';

export interface RatingBarProps {
  isRevealed: boolean;
  isFullyRevealed: boolean;
  revealStep: number;
  totalRevealSteps: number;
  ratingMode: RatingButtonMode;
  suggestedRating: ReviewRating | undefined;
  intervals: Readonly<Record<ReviewRating, { label: string }>> | null;
  onRevealNext: () => void;
  onRate: (rating: ReviewRating) => void;
}

interface RatingButtonSpec {
  rating: ReviewRating;
  testId: string;
  label: string;
  /** Number-key shortcut shown on the button (§5.1). */
  shortcut: string;
  tone: string;
  normal: string;
  suggested: string;
}

// Full class strings (not composed) so Tailwind's scanner keeps every utility.
const RATING_BUTTONS: readonly RatingButtonSpec[] = [
  {
    rating: 1,
    testId: 'rate-again',
    label: 'Again',
    shortcut: '1',
    tone: 'text-rose-600 hover:bg-rose-500/20 dark:text-rose-400',
    normal: 'border-rose-500/30 bg-rose-500/10',
    suggested: 'border-rose-500 bg-rose-500/20 ring-2 ring-rose-500/50',
  },
  {
    rating: 2,
    testId: 'rate-hard',
    label: 'Hard',
    shortcut: '4',
    tone: 'text-amber-600 hover:bg-amber-500/20 dark:text-amber-400',
    normal: 'border-amber-500/30 bg-amber-500/10',
    suggested: 'border-amber-500/30 bg-amber-500/10',
  },
  {
    rating: 3,
    testId: 'rate-good',
    label: 'Good',
    shortcut: '2',
    tone: 'text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400',
    normal: 'border-emerald-500/30 bg-emerald-500/10',
    suggested: 'border-emerald-500 bg-emerald-500/20 ring-2 ring-emerald-500/50',
  },
  {
    rating: 4,
    testId: 'rate-easy',
    label: 'Easy',
    shortcut: '3',
    tone: 'text-sky-600 hover:bg-sky-500/20 dark:text-sky-400',
    normal: 'border-sky-500/30 bg-sky-500/10',
    suggested: 'border-sky-500 bg-sky-500/20 ring-2 ring-sky-500/50',
  },
];

function isSuggested(
  rating: ReviewRating,
  suggested: ReviewRating | undefined,
  mode: RatingButtonMode,
): boolean {
  if (rating === 2) return false;
  if (rating === 3) return suggested === 3 || (suggested === 4 && mode === '2');
  return suggested === rating;
}

const ARROW_STEP: Record<string, number> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

/**
 * Show Answer / Reveal more / rating buttons (Phase 13).
 *
 * Keyboard & D-pad: buttons are in DOM (= tab) order; while a rating button has focus the
 * arrow keys move focus between them instead of rating (Enter / Space rates the focused one,
 * `1–4` still rate from anywhere). When a keyboard user's focused control disappears on
 * flip or rate, focus moves to the next sensible control instead of falling to `<body>`.
 */
export function RatingBar({
  isRevealed,
  isFullyRevealed,
  revealStep,
  totalRevealSteps,
  ratingMode,
  suggestedRating,
  intervals,
  onRevealNext,
  onRate,
}: RatingBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  // When a keyboard action inside the bar (Enter / Space on a button, or a 1–4 key while a
  // button has focus) flips or rates, the focused button unmounts. Remember when that happened.
  const keyboardActionAtRef = useRef(-Infinity);

  useLayoutEffect(() => {
    if (performance.now() - keyboardActionAtRef.current > 1000) return;
    keyboardActionAtRef.current = -Infinity;
    const active = document.activeElement;
    // Focus was lost only if it sits on <body> or on the button React just removed.
    if (active && active !== document.body && active.isConnected) return;
    barRef.current?.querySelector<HTMLButtonElement>('[data-focus-default]')?.focus();
  }, [isRevealed, isFullyRevealed, revealStep]);

  const visible = RATING_BUTTONS.filter(
    (b) => (b.rating !== 2 || ratingMode === '4') && (b.rating !== 4 || ratingMode !== '2'),
  );
  const defaultRating: ReviewRating =
    suggestedRating !== undefined && visible.some((b) => b.rating === suggestedRating)
      ? suggestedRating
      : 3;

  return (
    <div
      ref={barRef}
      className="flex shrink-0 flex-col gap-2 short:w-44 short:justify-end"
      onClickCapture={(e) => {
        // detail === 0: the click came from Enter / Space, not a pointer.
        if (e.detail === 0) keyboardActionAtRef.current = performance.now();
      }}
      onKeyDown={(e) => {
        if (/^[1-4]$/.test(e.key)) keyboardActionAtRef.current = performance.now();
      }}
    >
      {!isRevealed ? (
        <button
          key="reveal"
          type="button"
          data-testid="reveal-button"
          data-focus-default=""
          onClick={onRevealNext}
          className="w-full rounded-2xl bg-[var(--accent)] py-3.5 text-base font-semibold text-white shadow-sm hover:opacity-90 active:scale-[0.99] short:py-5"
        >
          Show Answer <span className="ml-1 text-xs opacity-80">(Space)</span>
        </button>
      ) : (
        <>
          {!isFullyRevealed && (
            <button
              key="reveal-more"
              type="button"
              data-testid="reveal-more-button"
              data-focus-default=""
              onClick={onRevealNext}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] py-2 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-2)]"
            >
              Reveal more ({revealStep}/{totalRevealSteps}) · Space
            </button>
          )}

          <div
            role="group"
            aria-label="Rate this card"
            data-testid="rating-bar"
            onKeyDown={(e) => {
              const buttons = [...e.currentTarget.querySelectorAll('button')];
              const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (idx < 0) return;
              const step = ARROW_STEP[e.key];
              const next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? buttons.length - 1
                    : step !== undefined
                      ? (idx + step + buttons.length) % buttons.length
                      : -1;
              if (next < 0) return;
              // Keep the arrow from also reaching the global ← / → rating shortcuts.
              e.preventDefault();
              e.stopPropagation();
              buttons[next]?.focus();
            }}
            className={`grid gap-2 short:grid-cols-1 ${
              ratingMode === '2'
                ? 'grid-cols-2'
                : ratingMode === '4'
                  ? 'grid-cols-4'
                  : 'grid-cols-3'
            }`}
          >
            {visible.map((b) => {
              const suggested = isSuggested(b.rating, suggestedRating, ratingMode);
              return (
                <button
                  key={b.rating}
                  type="button"
                  data-testid={b.testId}
                  data-suggested={suggested ? 'true' : undefined}
                  data-focus-default={
                    isFullyRevealed && b.rating === defaultRating ? '' : undefined
                  }
                  onClick={() => onRate(b.rating)}
                  className={`flex min-w-0 flex-col items-center justify-center rounded-2xl border py-3 transition-colors active:scale-[0.98] short:py-2 ${b.tone} ${
                    suggested ? b.suggested : b.normal
                  }`}
                >
                  <span className="text-sm font-bold">
                    {b.label}
                    {suggested ? ' ★' : ''}
                  </span>
                  <span className="text-xs opacity-80">
                    {intervals?.[b.rating].label ?? ''} · {b.shortcut}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
