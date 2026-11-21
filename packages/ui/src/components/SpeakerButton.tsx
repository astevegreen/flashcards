import { useEffect, useRef, useState } from 'react';

export interface SpeakerButtonProps {
  onPlay: (rate: number) => void;
  disabled?: boolean;
  showSlowButton?: boolean;
  label?: string;
  size?: 'sm' | 'md';
  testIdPrefix?: string;
}

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;

/**
 * Study-card & inline speaker trigger (§7.2):
 * - Tap / click → `1.0×` playback
 * - Pointer long-press (>= 450 ms) → `0.75×` slow playback with visual badge feedback
 * - Optional compact `0.75×` companion button for one-click mouse/keyboard access
 * - Stops pointer propagation so it never triggers card flip or swipe gestures.
 */
export function SpeakerButton({
  onPlay,
  disabled = false,
  showSlowButton = true,
  label = 'Play audio',
  size = 'md',
  testIdPrefix = 'study-audio',
}: SpeakerButtonProps) {
  const [slowBadgeVisible, setSlowBadgeVisible] = useState(false);
  const timerRef = useRef<number | null>(null);
  const badgeTimerRef = useRef<number | null>(null);
  const pressOriginRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const longPressFiredRef = useRef(false);

  const clearLongPressTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearLongPressTimer();
      if (badgeTimerRef.current !== null) {
        window.clearTimeout(badgeTimerRef.current);
      }
    };
  }, []);

  const flashSlowBadge = () => {
    setSlowBadgeVisible(true);
    if (badgeTimerRef.current !== null) {
      window.clearTimeout(badgeTimerRef.current);
    }
    badgeTimerRef.current = window.setTimeout(() => {
      setSlowBadgeVisible(false);
    }, 900);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    longPressFiredRef.current = false;
    pressOriginRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events without active pointer capture
    }

    clearLongPressTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      longPressFiredRef.current = true;
      flashSlowBadge();
      onPlay(0.75);
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const origin = pressOriginRef.current;
    if (!origin || origin.pointerId !== e.pointerId) return;
    if (
      Math.abs(e.clientX - origin.x) > MOVE_CANCEL_PX ||
      Math.abs(e.clientY - origin.y) > MOVE_CANCEL_PX
    ) {
      clearLongPressTimer();
      pressOriginRef.current = null;
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    clearLongPressTimer();
    pressOriginRef.current = null;
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    clearLongPressTimer();
    pressOriginRef.current = null;
    longPressFiredRef.current = false;
  };

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (disabled) return;
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    onPlay(e.shiftKey ? 0.75 : 1.0);
  };

  const btnPadding = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-2.5 py-1.5 text-xs';

  return (
    <div
      className="relative inline-flex items-center gap-1"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        disabled={disabled}
        data-testid={`${testIdPrefix}-play`}
        aria-label={`${label} (press R, or hold for 0.75× slow)`}
        title={`${label} (R) — hold for 0.75×`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        onClick={handleClick}
        className={`inline-flex select-none items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] font-medium text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] active:scale-95 disabled:opacity-40 ${btnPadding}`}
      >
        <span aria-hidden="true">🔊</span>
        <span>{slowBadgeVisible ? '0.75×' : 'Play'}</span>
      </button>

      {showSlowButton && (
        <button
          type="button"
          disabled={disabled}
          data-testid={`${testIdPrefix}-slow`}
          aria-label="Play audio slowly at 0.75× speed (press S)"
          title="Play slowly at 0.75× (S)"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled) onPlay(0.75);
          }}
          className={`inline-flex select-none items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] font-medium text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--fg)] active:scale-95 disabled:opacity-40 ${btnPadding}`}
        >
          0.75×
        </button>
      )}
    </div>
  );
}
