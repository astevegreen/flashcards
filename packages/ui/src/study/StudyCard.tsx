import type { ReactNode } from 'react';
import { SpeakerButton } from '../components/SpeakerButton.tsx';

export type SwipeIntent = 'again' | 'good' | 'easy' | null;

export interface StudyCardSwipe {
  dx: number;
  dy: number;
  active: boolean;
}

export interface StudyCardProps {
  answerMode: string;
  deckName: string;
  layoutLabel: string;
  isRevealed: boolean;
  /** Front of an interactive mode (typed / choice / draw): taps do not flip the card. */
  capturesFront: boolean;
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
};

/**
 * The swipeable / tappable study card (Phase 13 adaptive layout).
 *
 * Sizing lives in CSS: the card is a flex item that takes whatever height the study screen
 * leaves (never the page), and its body is a size container (`.card-scroll`) so the
 * `card-fit-*` text classes scale with the card and long content scrolls inside it.
 */
export function StudyCard({
  answerMode,
  deckName,
  layoutLabel,
  isRevealed,
  capturesFront,
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
  return (
    <div
      data-testid="study-card"
      data-answer-mode={answerMode}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        touchAction: 'pan-y',
        transform:
          swipe.active && isRevealed
            ? `translate3d(${Math.max(-90, Math.min(90, swipe.dx * 0.45))}px, ${Math.max(-50, Math.min(20, swipe.dy * 0.35))}px, 0)`
            : undefined,
      }}
      className={`study-card relative flex min-h-[9rem] min-w-0 flex-1 select-none flex-col rounded-3xl border bg-[var(--surface)] shadow-sm transition-transform duration-100 ${
        !isRevealed && capturesFront ? '' : 'cursor-pointer'
      } ${swipeIntent ? INTENT_BORDER[swipeIntent] : 'border-[var(--border)]'}`}
    >
      {/* Deck & layout pill + card controls (SpeakerButton, AI provenance badge, §7.2, §10.3) */}
      <div className="flex shrink-0 items-start justify-between gap-2 px-4 pt-3 text-xs text-[var(--muted)] sm:px-5 sm:pt-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{deckName}</span>
          <span aria-hidden="true">·</span>
          <span className="rounded-md bg-[var(--surface-2)] px-1.5 py-0.5">{layoutLabel}</span>
        </div>
        {swipeIntent ? (
          <div className="pointer-events-none rounded-full bg-[var(--surface-2)] px-3 py-1 text-xs font-bold uppercase tracking-wider text-[var(--fg)]">
            {swipeIntent}
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
        data-testid="study-card-body"
        data-revealed={isRevealed ? 'true' : 'false'}
        className="card-scroll min-h-0 flex-1"
      >
        <div className="flex min-h-full flex-col items-center justify-center gap-4 px-4 pb-5 pt-2 text-center sm:gap-6 sm:px-8 sm:pb-8">
          {children}
          {hint && <p className="text-xs text-[var(--muted)]">{hint}</p>}
        </div>
      </div>
    </div>
  );
}
