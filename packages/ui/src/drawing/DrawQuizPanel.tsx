import { mapDrawMistakesToRating, type StrokeScript } from '@flash/core/drawing';
import type { HanziStrokeData, InkStroke } from '@flash/platform';
import HanziWriter from 'hanzi-writer';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import type { AnswerEvaluation } from '../study/answerModes/types.ts';
import { CharacterGridSvg, PointerInkCanvas, type GridGuideMode } from './PointerInkCanvas.tsx';

export interface DrawQuizPanelProps {
  cardId: string;
  characters: readonly string[];
  script: StrokeScript;
  isRevealed: boolean;
  onEvaluateAndReveal: (evaluation: AnswerEvaluation) => void;
}

/**
 * Strictly lazy-loaded graded stroke drawing quiz powered by `hanzi-writer` (MIT) (§6.4).
 * - Keeps Japanese (`ja`, KanjiVG) and Chinese (`zh-Hans`, Make Me a Hanzi) stroke data strictly separate.
 * - Supports multi-character words, SVG grid guide, outline hint, stroke hint, undo stroke (`quizStartStrokeNum`),
 *   clear, reveal (`animateCharacter`), and mistake-to-FSRS rating (`0 → Easy`, `1–2 → Good`, `3+ → Again`).
 * - Falls back gracefully to freehand `PointerInkCanvas` if stroke data for a character is unavailable offline.
 */
export default function DrawQuizPanel({
  cardId,
  characters,
  script,
  isRevealed,
  onEvaluateAndReveal,
}: DrawQuizPanelProps) {
  const { platform } = useApp();

  const [charIndex, setCharIndex] = useState(0);
  const [strokeData, setStrokeData] = useState<HanziStrokeData | null>(null);
  const [loadingChar, setLoadingChar] = useState(true);
  const [missingOffline, setMissingOffline] = useState(false);

  const [gridMode, setGridMode] = useState<GridGuideMode>('star');
  const [showOutline, setShowOutline] = useState(false);
  const [currentStrokeNum, setCurrentStrokeNum] = useState(0);
  const [totalMistakes, setTotalMistakes] = useState(0);
  const [statusText, setStatusText] = useState('Draw stroke 1…');
  const [quizFinished, setQuizFinished] = useState(false);
  const [fallbackStrokes, setFallbackStrokes] = useState<InkStroke[]>([]);

  const targetRef = useRef<HTMLDivElement | null>(null);
  const writerRef = useRef<HanziWriter | null>(null);
  const totalMistakesRef = useRef(0);
  const charMistakesAtStartRef = useRef(0);
  const onEvaluateRef = useRef(onEvaluateAndReveal);
  onEvaluateRef.current = onEvaluateAndReveal;

  const activeChar = characters[charIndex] ?? '';
  const totalChars = characters.length;

  // Reset entire multi-character session when card changes
  useEffect(() => {
    setCharIndex(0);
    setTotalMistakes(0);
    totalMistakesRef.current = 0;
    charMistakesAtStartRef.current = 0;
    setCurrentStrokeNum(0);
    setShowOutline(false);
    setQuizFinished(false);
    setFallbackStrokes([]);
    setStatusText('Loading stroke data…');
  }, [cardId, characters, script]);

  // Fetch active character stroke data from StrokeDataProvider (local IDB -> packs.json host)
  useEffect(() => {
    let cancelled = false;
    setLoadingChar(true);
    setMissingOffline(false);
    setStrokeData(null);
    setCurrentStrokeNum(0);
    setFallbackStrokes([]);

    if (!activeChar || !platform.getStrokeDataProvider) {
      setLoadingChar(false);
      setMissingOffline(true);
      return undefined;
    }

    void platform
      .getStrokeDataProvider()
      .then((provider) => provider.getCharacterData(script, activeChar, { allowNetwork: true }))
      .then((data) => {
        if (cancelled) return;
        if (data) {
          setStrokeData(data);
          setMissingOffline(false);
        } else {
          setStrokeData(null);
          setMissingOffline(true);
        }
        setLoadingChar(false);
      })
      .catch(() => {
        if (!cancelled) {
          setStrokeData(null);
          setMissingOffline(true);
          setLoadingChar(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeChar, platform, script]);

  const startQuizFromStroke = useCallback(
    (writer: HanziWriter, startStroke: number) => {
      setCurrentStrokeNum(startStroke);
      setStatusText(`Draw stroke ${startStroke + 1} of ${strokeData?.strokes.length ?? '?'}…`);
      void writer.quiz({
        quizStartStrokeNum: startStroke,
        showHintAfterMisses: 3,
        highlightOnComplete: true,
        onMistake: (strokeInfo) => {
          totalMistakesRef.current += 1;
          setTotalMistakes(totalMistakesRef.current);
          setStatusText(
            `Mistake on stroke ${strokeInfo.strokeNum + 1} (mistakes: ${totalMistakesRef.current})`,
          );
        },
        onCorrectStroke: (strokeInfo) => {
          const nextNum = strokeInfo.strokeNum + 1;
          setCurrentStrokeNum(nextNum);
          if (strokeInfo.strokesRemaining > 0) {
            setStatusText(`Stroke ${nextNum} ✓ (${strokeInfo.strokesRemaining} remaining)`);
          }
        },
        onComplete: () => {
          const finalMistakes = totalMistakesRef.current;
          if (charIndex + 1 < totalChars) {
            charMistakesAtStartRef.current = finalMistakes;
            setStatusText(`Character ${charIndex + 1}/${totalChars} complete! Next character…`);
            setCharIndex((prev) => prev + 1);
          } else {
            const suggested = mapDrawMistakesToRating(finalMistakes);
            setQuizFinished(true);
            setStatusText(
              `Complete · ${finalMistakes} mistake${finalMistakes === 1 ? '' : 's'} → Suggested: ${
                suggested === 4 ? 'Easy' : suggested === 3 ? 'Good' : 'Again'
              }`,
            );
            onEvaluateRef.current({
              correct: finalMistakes <= 2,
              suggestedRating: suggested,
            });
          }
        },
      });
    },
    [charIndex, strokeData?.strokes.length, totalChars],
  );

  // Mount Hanzi Writer instance when character stroke data is ready
  useEffect(() => {
    const container = targetRef.current;
    if (!container || !strokeData || !activeChar) return undefined;

    container.innerHTML = '';
    const isDark =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

    const writer = HanziWriter.create(container, activeChar, {
      width: 240,
      height: 240,
      padding: 12,
      showOutline,
      showCharacter: isRevealed,
      strokeColor: isDark ? '#e2e8f0' : '#0f172a',
      outlineColor: isDark ? '#334155' : '#cbd5e1',
      drawingColor: '#2563eb',
      highlightColor: '#10b981',
      drawingWidth: 16,
      charDataLoader: (_char, onLoad) => {
        onLoad(strokeData);
      },
    });
    writerRef.current = writer;

    if (!isRevealed && !quizFinished) {
      startQuizFromStroke(writer, 0);
    }

    return () => {
      try {
        writer.cancelQuiz();
      } catch {
        // Ignore cleanup errors if already unmounted
      }
      writerRef.current = null;
      container.innerHTML = '';
    };
    // Intentionally recreate writer only when character or strokeData changes (outline toggles imperatively)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChar, strokeData, cardId]);

  // Sync outline visibility without restarting active quiz
  useEffect(() => {
    const writer = writerRef.current;
    if (!writer) return;
    if (showOutline) {
      void writer.showOutline();
    } else {
      void writer.hideOutline();
    }
  }, [showOutline]);

  const handleUndoStroke = () => {
    const writer = writerRef.current;
    if (!writer || isRevealed || currentStrokeNum <= 0) return;
    writer.cancelQuiz();
    const prevStroke = Math.max(0, currentStrokeNum - 1);
    startQuizFromStroke(writer, prevStroke);
  };

  const handleClear = () => {
    const writer = writerRef.current;
    if (!writer || isRevealed) return;
    writer.cancelQuiz();
    startQuizFromStroke(writer, 0);
  };

  const handleStrokeHint = () => {
    const writer = writerRef.current;
    if (!writer || isRevealed || !strokeData) return;
    if (currentStrokeNum < strokeData.strokes.length) {
      void writer.highlightStroke(currentStrokeNum);
    }
  };

  const handleReveal = () => {
    const writer = writerRef.current;
    if (writer) {
      writer.cancelQuiz();
      void writer.showOutline();
      void writer.animateCharacter();
    }
    setQuizFinished(true);
    setStatusText('Answer revealed · Suggested: Again (overridable)');
    onEvaluateAndReveal({
      correct: false,
      suggestedRating: 1,
    });
  };

  const handleAnimateAgain = () => {
    const writer = writerRef.current;
    if (!writer) return;
    void writer.animateCharacter();
  };

  const cycleGrid = () => {
    setGridMode((prev) => (prev === 'star' ? 'cross' : prev === 'cross' ? 'none' : 'star'));
  };

  if (loadingChar) {
    return (
      <div
        data-testid="draw-quiz-loading"
        className="flex h-[240px] w-[240px] items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--bg)] text-xs text-[var(--muted)]"
      >
        Loading stroke data…
      </div>
    );
  }

  // Graceful offline fallback when stroke data isn't cached yet
  if (missingOffline || !strokeData) {
    return (
      <div
        data-testid="draw-quiz-fallback"
        className="flex flex-col items-center gap-3"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <p className="max-w-xs text-xs text-amber-700 dark:text-amber-300">
          Stroke data for this character ({script === 'ja' ? 'KanjiVG JA' : 'Make Me a Hanzi ZH'})
          isn’t cached offline yet. Practice freehand below or pre-cache this deck in Library.
        </p>
        <PointerInkCanvas
          size={240}
          strokes={fallbackStrokes}
          onChangeStrokes={setFallbackStrokes}
          disabled={isRevealed}
          testIdPrefix="draw-fallback-canvas"
          {...(!isRevealed
            ? {
                onReveal: () =>
                  onEvaluateAndReveal({
                    correct: false,
                    suggestedRating: 3,
                  }),
              }
            : {})}
          revealLabel="Reveal & Self-Rate"
        />
      </div>
    );
  }

  return (
    <div
      data-testid="draw-quiz-panel"
      data-stroke-script={script}
      data-mistakes={totalMistakes}
      data-current-stroke={currentStrokeNum}
      data-total-strokes={strokeData.strokes.length}
      className="flex flex-col items-center gap-2.5"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      {/* Multi-character progress pills + script provenance pill */}
      <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs">
        <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">
          {script === 'ja' ? 'JA · KanjiVG' : 'ZH · Make Me a Hanzi'}
        </span>
        {totalChars > 1 &&
          characters.map((ch, idx) => {
            const done = idx < charIndex || quizFinished;
            const active = idx === charIndex && !quizFinished;
            return (
              <span
                key={`${ch}-${idx}`}
                data-testid={`draw-char-pill-${idx}`}
                className={`rounded-full px-2 py-0.5 font-semibold ${
                  done
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : active
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-[var(--accent)]'
                      : 'bg-[var(--surface-2)] text-[var(--muted)]'
                }`}
              >
                {done || isRevealed ? ch : `#${idx + 1}`}
              </span>
            );
          })}
        <span
          data-testid="draw-mistake-counter"
          className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 font-mono text-[11px] text-[var(--muted)]"
        >
          Mistakes: {totalMistakes}
        </span>
      </div>

      {/* Hanzi Writer SVG Quiz Target with Grid Guide & touch-action: none */}
      <div
        className="relative overflow-hidden rounded-2xl border-2 border-[var(--border)] bg-[var(--bg)] shadow-inner"
        style={{ width: 240, height: 240, touchAction: 'none' }}
      >
        <CharacterGridSvg mode={gridMode} />
        <div
          ref={targetRef}
          data-testid="hanzi-writer-target"
          data-grid-mode={gridMode}
          aria-label="Graded stroke drawing quiz canvas"
          className="relative z-10 h-[240px] w-[240px]"
          style={{ touchAction: 'none' }}
        />
      </div>

      <div data-testid="draw-quiz-status" className="text-xs font-medium text-[var(--muted)]">
        {statusText}
      </div>

      {/* Controls: Undo Stroke, Clear, Grid, Outline, Hint, Reveal / Animate */}
      <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs">
        {!isRevealed ? (
          <>
            <button
              type="button"
              data-testid="draw-undo-stroke"
              disabled={currentStrokeNum <= 0}
              onClick={handleUndoStroke}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--fg)] hover:bg-[var(--surface-2)] disabled:opacity-40"
            >
              Undo Stroke
            </button>
            <button
              type="button"
              data-testid="draw-clear"
              onClick={handleClear}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--fg)] hover:bg-[var(--surface-2)]"
            >
              Clear
            </button>
            <button
              type="button"
              data-testid="draw-grid-toggle"
              onClick={cycleGrid}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Grid: {gridMode === 'star' ? '米' : gridMode === 'cross' ? '田' : 'Off'}
            </button>
            <button
              type="button"
              data-testid="draw-outline-toggle"
              aria-pressed={showOutline}
              onClick={() => setShowOutline((v) => !v)}
              className={`rounded-lg border px-2.5 py-1 font-medium ${
                showOutline
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--fg)]'
              }`}
            >
              Outline
            </button>
            <button
              type="button"
              data-testid="draw-hint-stroke"
              onClick={handleStrokeHint}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Hint
            </button>
            <button
              type="button"
              data-testid="draw-reveal-btn"
              onClick={handleReveal}
              className="rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-2.5 py-1 font-semibold text-[var(--accent)] hover:opacity-90"
            >
              Reveal
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="draw-animate-btn"
            onClick={handleAnimateAgain}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 font-semibold text-[var(--fg)] hover:bg-[var(--surface-2)]"
          >
            ▶ Replay Stroke Order
          </button>
        )}
      </div>
    </div>
  );
}
