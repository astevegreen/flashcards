import type { RubyDisplay } from '@flash/core';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { RubyDisplayContext } from '../components/RichText.tsx';
import { SpeakerButton } from '../components/SpeakerButton.tsx';
import {
  canVerticalSwipeFromScroll,
  SWIPE_INTENT_LABEL,
  type SwipeIntent,
} from './studyGestures.ts';

export type { SwipeIntent };

export interface StudyCardSwipe {
  dx: number;
  dy: number;
  active: boolean;
}

export interface StudyCardProps {
  answerMode: string;
  /** The layout's ruby flag, applied to every field rendered inside the card. */
  rubyDisplay?: RubyDisplay | undefined;
  deckName: string;
  layoutLabel: string;
  isRevealed: boolean;
  /** True when the final reveal step ("third side" extras) is open on a multi-step card. */
  isExtrasOpen?: boolean;
  /** Front of an interactive mode (typed / choice / draw): taps do not flip the card. */
  capturesFront: boolean;
  /** Whether swiping the card is currently allowed (revealed, or non-interactive front). */
  canSwipe: boolean;
  /** Whether a right-swipe (Back / Undo) has a previous card to return to. */
  canUndo: boolean;
  /** Brief visual bounce when swiping right with nothing to undo. */
  bounceBack?: boolean;
  onBounceEnd?: () => void;
  /** Optional ref to the `.card-scroll` body for scroll-edge swipe coordination. */
  scrollRef?: RefObject<HTMLDivElement | null>;
  hint: string | null;
  swipe: StudyCardSwipe;
  swipeIntent: SwipeIntent;
  showSpeaker: boolean;
  onSpeak: (rate?: number) => void;
  needsAiReview: boolean;
  onMarkReviewed: () => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
  /** The answer-mode renderer output (§5.2). */
  children: ReactNode;
}

const INTENT_BORDER: Record<Exclude<SwipeIntent, null>, string> = {
  again: 'border-rose-500 ring-2 ring-rose-500/30',
  good: 'border-emerald-500 ring-2 ring-emerald-500/30',
  easy: 'border-sky-500 ring-2 ring-sky-500/30',
  back: 'border-violet-500 ring-2 ring-violet-500/30',
};

const BACK_DISABLED_BORDER = 'border-slate-400 ring-2 ring-slate-400/20';

/**
 * The swipeable / tappable study card (Phase 13 adaptive layout).
 *
 * Sizing lives in CSS: the card is a flex item that takes whatever height the study screen
 * leaves (never the page), and its body is a size container (`.card-scroll`) so the
 * `card-fit-*` text classes scale with the card and long content scrolls inside it.
 *
 * Touch-action: when the card body fits without scrolling, `touch-action: none` lets all 4
 * swipe directions (including vertical Up/Down on Android WebView) run without browser
 * scroll cancellation. When the body overflows, `.card-scroll` switches to `pan-y` for
 * native vertical scrolling, while a non-passive edge check still lets outward edge swipes
 * and header swipes work reliably.
 */
export function StudyCard({
  answerMode,
  rubyDisplay,
  deckName,
  layoutLabel,
  isRevealed,
  isExtrasOpen = false,
  capturesFront,
  canSwipe,
  canUndo,
  bounceBack = false,
  onBounceEnd,
  scrollRef,
  hint,
  swipe,
  swipeIntent,
  showSpeaker,
  onSpeak,
  needsAiReview,
  onMarkReviewed,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  children,
}: StudyCardProps) {
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = scrollRef ?? internalScrollRef;
  const [bodyOverflows, setBodyOverflows] = useState(false);

  // Measure whether `.card-scroll` currently overflows vertically.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      setBodyOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (innerRef.current) ro.observe(innerRef.current);
    return () => ro.disconnect();
  }, [bodyRef, isRevealed, isExtrasOpen, children]);

  // When the body overflows, prevent browser overscroll/pointercancel ONLY on outward vertical
  // drags at the scroll edge so vertical swipes still work while mid-body scrolling stays native.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !bodyOverflows || !canSwipe) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length !== 1) {
        tracking = false;
        return;
      }
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 4) {
        if (canVerticalSwipeFromScroll(dy, el.scrollTop, el.scrollHeight, el.clientHeight)) {
          e.preventDefault();
        } else {
          // User is actively scrolling inside the body; stop intercepting this touch.
          tracking = false;
        }
      }
    };
    const onTouchEnd = () => {
      tracking = false;
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [bodyOverflows, bodyRef, canSwipe]);

  const borderClass = swipeIntent
    ? swipeIntent === 'back' && !canUndo
      ? BACK_DISABLED_BORDER
      : INTENT_BORDER[swipeIntent]
    : 'border-[var(--border)]';

  return (
    <div
      data-testid="study-card"
      data-answer-mode={answerMode}
      data-swipe-intent={swipeIntent ?? undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onAnimationEnd={bounceBack ? onBounceEnd : undefined}
      style={{
        touchAction: 'none',
        transform:
          swipe.active && canSwipe
            ? `translate3d(${Math.max(-90, Math.min(90, swipe.dx * 0.45))}px, ${Math.max(-60, Math.min(60, swipe.dy * 0.4))}px, 0)`
            : undefined,
      }}
      className={`study-card relative flex min-h-[7rem] min-w-0 flex-1 select-none flex-col rounded-3xl border bg-[var(--surface)] shadow-sm transition-transform duration-100 sm:min-h-[9rem] ${
        !isRevealed && capturesFront ? '' : 'cursor-pointer'
      } ${bounceBack ? 'study-card-bounce-right' : ''} ${borderClass}`}
    >
      {/* Deck & layout pill + card controls (SpeakerButton, AI provenance badge, §7.2, §10.3) */}
      <div className="flex shrink-0 items-start justify-between gap-2 px-4 pt-3 text-xs text-[var(--muted)] sm:px-5 sm:pt-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{deckName}</span>
          <span aria-hidden="true">·</span>
          <span className="rounded-md bg-[var(--surface-2)] px-1.5 py-0.5">{layoutLabel}</span>
        </div>
        {swipeIntent ? (
          <div
            data-testid="swipe-intent-badge"
            className="pointer-events-none rounded-full bg-[var(--surface-2)] px-3 py-1 text-xs font-bold tracking-wide text-[var(--fg)]"
          >
            {SWIPE_INTENT_LABEL[swipeIntent]}
          </div>
        ) : (
          <div
            className="flex flex-wrap items-center justify-end gap-1.5"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            {showSpeaker && <SpeakerButton onPlay={onSpeak} testIdPrefix="study-audio" size="sm" />}
            {needsAiReview && (
              <>
                <span
                  data-testid="needs-review-badge"
                  className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300"
                >
                  Needs review
                </span>
                <button
                  type="button"
                  data-testid="mark-reviewed-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMarkReviewed();
                  }}
                  className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300"
                >
                  Mark reviewed
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Size container: text scales with it, overflow scrolls here instead of the page. */}
      <div
        ref={bodyRef}
        data-testid="study-card-body"
        data-revealed={isRevealed ? 'true' : 'false'}
        data-extras-open={isExtrasOpen ? 'true' : 'false'}
        data-overflowing={bodyOverflows ? 'true' : 'false'}
        style={{ touchAction: bodyOverflows ? 'pan-y' : 'none' }}
        className="card-scroll min-h-0 flex-1"
      >
        <div
          ref={innerRef}
          className="card-scroll-inner flex min-h-full flex-col items-center gap-4 px-4 pb-5 pt-2 text-center sm:gap-6 sm:px-8 sm:pb-8"
        >
          <RubyDisplayContext.Provider value={rubyDisplay ?? 'both'}>
            {children}
          </RubyDisplayContext.Provider>
          {hint && (
            <p data-testid="card-reveal-hint" className="text-xs text-[var(--muted)]">
              {hint}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
