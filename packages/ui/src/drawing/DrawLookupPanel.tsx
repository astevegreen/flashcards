import type { HandwritingCandidate, InkStroke } from '@flash/platform';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { PointerInkCanvas } from './PointerInkCanvas.tsx';

export interface DrawLookupPanelProps {
  lang?: string;
  size?: number;
  disabled?: boolean;
  onSelectCandidate?: (char: string) => void;
  onCandidatesChange?: (candidates: readonly HandwritingCandidate[]) => void;
  onReveal?: () => void;
  revealLabel?: string;
  testIdPrefix?: string;
}

/**
 * Draw-to-Lookup handwriting panel (§6.4):
 * Uses `PointerInkCanvas` + platform `HandwritingRecognizer` (custom MIT stroke matcher on web;
 * drop-in ML Kit Digital Ink on native Phase 8 shells).
 */
export function DrawLookupPanel({
  lang = 'ko',
  size = 220,
  disabled = false,
  onSelectCandidate,
  onCandidatesChange,
  onReveal,
  revealLabel,
  testIdPrefix = 'draw-lookup',
}: DrawLookupPanelProps) {
  const { platform } = useApp();
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [candidates, setCandidates] = useState<HandwritingCandidate[]>([]);
  const [recognizerReady, setRecognizerReady] = useState<boolean | null>(null);
  const [recognizerLabel, setRecognizerLabel] = useState('Web Stroke Matcher');
  const [busy, setBusy] = useState(false);

  const reqSeqRef = useRef(0);
  const onCandidatesChangeRef = useRef(onCandidatesChange);
  onCandidatesChangeRef.current = onCandidatesChange;

  useEffect(() => {
    let cancelled = false;
    if (!platform.getHandwritingRecognizer) {
      setRecognizerReady(false);
      return undefined;
    }
    void platform
      .getHandwritingRecognizer()
      .then(async (rec) => {
        if (cancelled) return;
        setRecognizerLabel(rec.isNative ? 'ML Kit Digital Ink' : 'Web Stroke Matcher');
        const ready = await rec.isReady(lang);
        if (!cancelled) setRecognizerReady(ready);
      })
      .catch(() => {
        if (!cancelled) setRecognizerReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lang, platform]);

  useEffect(() => {
    if (strokes.length === 0) {
      setCandidates([]);
      onCandidatesChangeRef.current?.([]);
      return undefined;
    }
    if (!platform.getHandwritingRecognizer) return undefined;

    const seq = ++reqSeqRef.current;
    const timer = window.setTimeout(() => {
      setBusy(true);
      void platform
        .getHandwritingRecognizer?.()
        .then((rec) => rec.recognize(strokes, { lang, maxResults: 12 }))
        .then((res) => {
          if (reqSeqRef.current !== seq) return;
          setCandidates(res);
          onCandidatesChangeRef.current?.(res);
          setBusy(false);
        })
        .catch(() => {
          if (reqSeqRef.current === seq) setBusy(false);
        });
    }, 90);

    return () => window.clearTimeout(timer);
  }, [lang, platform, strokes]);

  return (
    <div
      data-testid={`${testIdPrefix}-panel`}
      className="flex flex-col items-center gap-3"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] text-[var(--muted)]">
        <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 font-medium">
          {recognizerLabel}
        </span>
        <span>Strokes: {strokes.length}</span>
        {busy && <span>Matching…</span>}
      </div>

      {recognizerReady === false && (
        <div
          data-testid={`${testIdPrefix}-no-index`}
          className="max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-800 dark:text-amber-200"
        >
          Install a stroke pack (<strong>Make Me a Hanzi</strong> or <strong>KanjiVG</strong>) in
          Settings → Offline Packs to enable offline handwriting recognition.
        </div>
      )}

      <PointerInkCanvas
        size={size}
        strokes={strokes}
        onChangeStrokes={setStrokes}
        disabled={disabled}
        {...(onReveal ? { onReveal } : {})}
        {...(revealLabel ? { revealLabel } : {})}
        testIdPrefix={`${testIdPrefix}-canvas`}
      />

      {/* Candidate Character Strip */}
      <div
        data-testid={`${testIdPrefix}-candidates`}
        className="flex min-h-[2.75rem] w-full max-w-md flex-wrap items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-2"
      >
        {candidates.length === 0 ? (
          <span className="text-xs text-[var(--muted)]">
            {strokes.length === 0
              ? 'Draw a character above to see candidates…'
              : recognizerReady === false
                ? 'No stroke index installed yet.'
                : 'No matching candidates yet — keep drawing or clear.'}
          </span>
        ) : (
          candidates.map((cand) => (
            <button
              key={cand.character}
              type="button"
              lang={lang === 'any' ? 'ko' : lang}
              data-testid={`${testIdPrefix}-candidate-${cand.character}`}
              onClick={() => onSelectCandidate?.(cand.character)}
              title={`Match ${Math.round(cand.score * 100)}% (${cand.strokeCount} strokes)`}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xl font-medium text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
            >
              {cand.character}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
