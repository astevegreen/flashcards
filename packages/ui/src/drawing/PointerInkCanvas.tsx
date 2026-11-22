import type { InkPoint, InkStroke } from '@flash/platform';
import { useCallback, useEffect, useRef, useState } from 'react';

export type GridGuideMode = 'star' | 'cross' | 'none';

export interface PointerInkCanvasProps {
  size?: number;
  strokes: readonly InkStroke[];
  onChangeStrokes: (next: InkStroke[]) => void;
  disabled?: boolean;
  initialGrid?: GridGuideMode;
  onReveal?: () => void;
  revealLabel?: string;
  testIdPrefix?: string;
}

/**
 * Reusable SVG grid guide overlay (米字格 / 田字格 / off) used behind both
 * PointerInkCanvas (Draw-to-Lookup) and Hanzi Writer (Graded Draw Quiz).
 */
export function CharacterGridSvg({ mode }: { mode: GridGuideMode }) {
  if (mode === 'none') return null;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      className="pointer-events-none absolute inset-0 h-full w-full text-[var(--border)]"
    >
      <line
        x1="50"
        y1="0"
        x2="50"
        y2="100"
        stroke="currentColor"
        strokeWidth="0.7"
        strokeDasharray="3 3"
      />
      <line
        x1="0"
        y1="50"
        x2="100"
        y2="50"
        stroke="currentColor"
        strokeWidth="0.7"
        strokeDasharray="3 3"
      />
      {mode === 'star' && (
        <>
          <line
            x1="0"
            y1="0"
            x2="100"
            y2="100"
            stroke="currentColor"
            strokeWidth="0.5"
            strokeDasharray="2 4"
            opacity="0.7"
          />
          <line
            x1="100"
            y1="0"
            x2="0"
            y2="100"
            stroke="currentColor"
            strokeWidth="0.5"
            strokeDasharray="2 4"
            opacity="0.7"
          />
        </>
      )}
    </svg>
  );
}

/**
 * Pointer Events freehand ink canvas (§6.4):
 * - `touch-action: none` prevents mobile scrolling while drawing
 * - `setPointerCapture` tracks strokes cleanly across canvas boundaries
 * - Preserves `(x, y, t)` timestamps for Phase 8 ML Kit Digital Ink compatibility
 * - Supports Grid guide toggle, Undo Stroke, Clear, and optional Reveal
 */
export function PointerInkCanvas({
  size = 240,
  strokes,
  onChangeStrokes,
  disabled = false,
  initialGrid = 'star',
  onReveal,
  revealLabel = 'Reveal',
  testIdPrefix = 'ink-canvas',
}: PointerInkCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const activeStrokeRef = useRef<InkPoint[] | null>(null);
  const strokesRef = useRef<readonly InkStroke[]>(strokes);
  strokesRef.current = strokes;

  const [gridMode, setGridMode] = useState<GridGuideMode>(initialGrid);
  const [liveStroke, setLiveStroke] = useState<InkPoint[] | null>(null);

  const redraw = useCallback(
    (committed: readonly InkStroke[], inProgress: readonly InkPoint[] | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr =
        typeof window !== 'undefined' ? Math.max(1, Math.min(3, window.devicePixelRatio || 1)) : 1;
      const pixelSize = Math.round(size * dpr);
      if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
        canvas.width = pixelSize;
        canvas.height = pixelSize;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, size, size);

      const strokeColor =
        typeof window !== 'undefined' ? getComputedStyle(canvas).color || '#0f172a' : '#0f172a';
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = Math.max(5, Math.round(size / 42));
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const drawOne = (pts: readonly InkPoint[]) => {
        if (pts.length === 0) return;
        const p0 = pts[0];
        if (!p0) return;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        if (pts.length === 1) {
          ctx.lineTo(p0.x + 0.1, p0.y + 0.1);
        } else {
          for (let i = 1; i < pts.length - 1; i++) {
            const curr = pts[i];
            const next = pts[i + 1];
            if (!curr || !next) continue;
            const midX = (curr.x + next.x) / 2;
            const midY = (curr.y + next.y) / 2;
            ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
          }
          const last = pts[pts.length - 1];
          if (last) ctx.lineTo(last.x, last.y);
        }
        ctx.stroke();
      };

      for (const s of committed) drawOne(s);
      if (inProgress && inProgress.length > 0) drawOne(inProgress);
      ctx.restore();
    },
    [size],
  );

  useEffect(() => {
    redraw(strokes, liveStroke);
  }, [liveStroke, redraw, strokes]);

  const toCanvasPoint = (e: PointerEvent | React.PointerEvent<HTMLCanvasElement>): InkPoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0, t: Date.now() };
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? size / rect.width : 1;
    const scaleY = rect.height > 0 ? size / rect.height : 1;
    return {
      x: Math.max(0, Math.min(size, (e.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(size, (e.clientY - rect.top) * scaleY)),
      t: Date.now(),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    activePointerIdRef.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events without pointer capture
    }
    const pt = toCanvasPoint(e);
    activeStrokeRef.current = [pt];
    setLiveStroke([pt]);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (activePointerIdRef.current !== e.pointerId || !activeStrokeRef.current) return;
    const nativeEvt = e.nativeEvent as PointerEvent & {
      getCoalescedEvents?: () => PointerEvent[];
    };
    const samples =
      typeof nativeEvt.getCoalescedEvents === 'function' ? nativeEvt.getCoalescedEvents() : [];
    const targetEvents = samples.length > 0 ? samples : [nativeEvt];
    const current = activeStrokeRef.current;
    for (const evt of targetEvents) {
      const pt = toCanvasPoint(evt);
      const prev = current[current.length - 1];
      if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) >= 1.5) {
        current.push(pt);
      }
    }
    setLiveStroke([...current]);
  };

  const finishStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    const finished = activeStrokeRef.current;
    activeStrokeRef.current = null;
    setLiveStroke(null);
    if (finished && finished.length > 0) {
      onChangeStrokes([...strokesRef.current, finished]);
    }
  };

  const handleUndoStroke = () => {
    if (strokes.length === 0) return;
    onChangeStrokes(strokes.slice(0, -1));
  };

  const handleClear = () => {
    activeStrokeRef.current = null;
    activePointerIdRef.current = null;
    setLiveStroke(null);
    onChangeStrokes([]);
  };

  const cycleGrid = () => {
    setGridMode((prev) => (prev === 'star' ? 'cross' : prev === 'cross' ? 'none' : 'star'));
  };

  return (
    <div
      className="flex flex-col items-center gap-2"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div
        className="relative overflow-hidden rounded-2xl border-2 border-[var(--border)] bg-[var(--bg)] shadow-inner"
        style={{ width: size, height: size, touchAction: 'none' }}
      >
        <CharacterGridSvg mode={gridMode} />
        <canvas
          ref={canvasRef}
          data-testid={testIdPrefix}
          data-grid-mode={gridMode}
          aria-label="Character drawing canvas"
          width={size}
          height={size}
          style={{ width: size, height: size, touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          className="relative z-10 block cursor-crosshair text-[var(--fg)]"
        />
      </div>

      <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs">
        <button
          type="button"
          data-testid={`${testIdPrefix}-undo`}
          disabled={disabled || strokes.length === 0}
          onClick={handleUndoStroke}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--fg)] hover:bg-[var(--surface-2)] disabled:opacity-40"
        >
          Undo Stroke
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-clear`}
          disabled={disabled || strokes.length === 0}
          onClick={handleClear}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--fg)] hover:bg-[var(--surface-2)] disabled:opacity-40"
        >
          Clear
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-grid`}
          onClick={cycleGrid}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--muted)] hover:text-[var(--fg)]"
        >
          Grid: {gridMode === 'star' ? '米' : gridMode === 'cross' ? '田' : 'Off'}
        </button>
        {onReveal && (
          <button
            type="button"
            data-testid={`${testIdPrefix}-reveal`}
            disabled={disabled}
            onClick={onReveal}
            className="rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-2.5 py-1 font-semibold text-[var(--accent)] hover:opacity-90 disabled:opacity-40"
          >
            {revealLabel}
          </button>
        )}
      </div>
    </div>
  );
}
