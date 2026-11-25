import type { RatingButtonMode } from '@flash/core';

export interface SwipeGuideBannerProps {
  ratingMode: RatingButtonMode;
  onDismiss: () => void;
}

/**
 * One-time, dismissible touch swipe tutorial hint on the Study screen.
 * Lazily loaded so desktop and returning users pay zero initial bundle cost (§8).
 */
export function SwipeGuideBanner({ ratingMode, onDismiss }: Readonly<SwipeGuideBannerProps>) {
  const upLabel = ratingMode === '2' ? 'Good' : 'Easy';
  return (
    <aside
      aria-label="Swipe gestures guide"
      data-testid="swipe-guide"
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent-soft)] px-3 py-2 text-xs text-[var(--fg)] short:hidden"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <span className="font-semibold text-[var(--accent)]">Swipe card:</span>
        <span>← Good</span>
        <span>↓ Again</span>
        <span>↑ {upLabel}</span>
        <span>→ Back</span>
        <span className="text-[var(--muted)]">· Tap to flip</span>
      </div>
      <button
        type="button"
        data-testid="swipe-guide-dismiss"
        onClick={onDismiss}
        className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1 font-semibold text-[var(--fg)] hover:bg-[var(--surface-2)]"
      >
        Got it
      </button>
    </aside>
  );
}
