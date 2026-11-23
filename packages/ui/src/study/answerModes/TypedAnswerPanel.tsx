import type { RubyDisplay } from '@flash/core';
import {
  convertJaRomajiLive,
  matchTypedAnswer,
  type AnswerMatchResult,
} from '@flash/core/answer-match';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useApp } from '../../state/AppContext.tsx';
import type { AnswerEvaluation } from './types.ts';

export interface TypedAnswerPanelProps {
  cardId: string;
  expectedRaw: string;
  rubyDisplay?: RubyDisplay;
  lang: string;
  isRevealed: boolean;
  placeholder?: string;
  onEvaluateAndReveal: (evaluation: AnswerEvaluation) => void;
}

/**
 * Strictly lazy-loaded typed-answer input + character diff panel (§5.2 & §8).
 * Imports `wanakana` via `@flash/core/answer-match` so initial Flip study JS pays 0 KB.
 */
export default function TypedAnswerPanel({
  cardId,
  expectedRaw,
  rubyDisplay,
  lang,
  isRevealed,
  placeholder = 'Type your answer…',
  onEvaluateAndReveal,
}: TypedAnswerPanelProps) {
  const { state, updatePreferences } = useApp();
  const isJa = lang.toLowerCase() === 'ja' || lang.toLowerCase().startsWith('ja-');
  const isZh = lang.toLowerCase() === 'zh' || lang.toLowerCase().startsWith('zh-');

  const [value, setValue] = useState('');
  const [liveRomaji, setLiveRomaji] = useState(isJa);
  const [result, setResult] = useState<AnswerMatchResult | null>(null);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const jaKanaEquivalent = state.preferences.ja_kana_equivalent ?? true;
  const zhIgnoreTones = state.preferences.zh_ignore_tones ?? false;

  useEffect(() => {
    setValue('');
    setResult(null);
    setLiveRomaji(isJa);
    composingRef.current = false;
    inputRef.current?.focus();
  }, [cardId, isJa]);

  // Re-evaluate live if user flips ja_kana_equivalent / zh_ignore_tones toggle after revealing
  useEffect(() => {
    if (!result || !isRevealed) return;
    const next = matchTypedAnswer(value, expectedRaw, {
      lang,
      jaKanaEquivalent,
      zhIgnoreTones,
      ...(rubyDisplay ? { rubyDisplay } : {}),
    });
    setResult(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jaKanaEquivalent, zhIgnoreTones]);

  const submitAnswer = () => {
    if (isRevealed) return;
    const evaluated = matchTypedAnswer(value, expectedRaw, {
      lang,
      jaKanaEquivalent,
      zhIgnoreTones,
      ...(rubyDisplay ? { rubyDisplay } : {}),
    });
    setResult(evaluated);
    onEvaluateAndReveal({
      correct: evaluated.correct,
      suggestedRating: evaluated.suggestedRating,
      typedAnswer: value.trim(),
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // §5.2 strict IME safety: ignore Enter while composing or keyCode === 229
    if (e.key === 'Enter') {
      const nativeEvt = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
      if (
        composingRef.current ||
        nativeEvt.isComposing ||
        nativeEvt.keyCode === 229 ||
        e.keyCode === 229
      ) {
        return;
      }
      e.preventDefault();
      submitAnswer();
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (composingRef.current) return;
    submitAnswer();
  };

  const handleChange = (nextRaw: string) => {
    if (isJa && liveRomaji && !composingRef.current) {
      setValue(convertJaRomajiLive(nextRaw));
    } else {
      setValue(nextRaw);
    }
  };

  return (
    <div
      data-testid="typed-answer-panel"
      className="flex w-full max-w-md flex-col items-stretch gap-3"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      {!isRevealed ? (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              lang={lang}
              data-testid="typed-answer-input"
              aria-label="Type your answer"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={placeholder}
              value={value}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={(e) => {
                composingRef.current = false;
                if (isJa && liveRomaji) {
                  setValue(convertJaRomajiLive(e.currentTarget.value));
                }
              }}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3.5 py-2.5 text-base text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="submit"
              data-testid="typed-answer-submit"
              className="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
            >
              Check
            </button>
          </div>

          {(isJa || isZh) && (
            <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-[var(--muted)]">
              {isJa && (
                <>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={liveRomaji}
                      onChange={(e) => setLiveRomaji(e.target.checked)}
                    />
                    <span>Romaji → Kana</span>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={jaKanaEquivalent}
                      onChange={(e) => updatePreferences({ ja_kana_equivalent: e.target.checked })}
                    />
                    <span>Hiragana = Katakana</span>
                  </label>
                </>
              )}
              {isZh && (
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={zhIgnoreTones}
                    onChange={(e) => updatePreferences({ zh_ignore_tones: e.target.checked })}
                  />
                  <span>Ignore tones</span>
                </label>
              )}
            </div>
          )}
        </form>
      ) : result ? (
        <div
          data-testid="typed-answer-feedback"
          className={`flex flex-col gap-2 rounded-2xl border p-3.5 text-left ${
            result.correct
              ? 'border-emerald-500/40 bg-emerald-500/10'
              : 'border-rose-500/40 bg-rose-500/10'
          }`}
        >
          <div className="flex items-center justify-between gap-2 text-xs font-bold uppercase tracking-wide">
            <span
              className={
                result.correct
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-rose-700 dark:text-rose-300'
              }
            >
              {result.correct ? 'Correct ✓' : 'Check differences'}
            </span>
            <span className="text-[var(--muted)]">
              Suggested: {result.suggestedRating === 3 ? 'Good' : 'Again'}
            </span>
          </div>

          <div
            data-testid="typed-answer-diff"
            lang={lang}
            className="flex flex-wrap items-center gap-0.5 font-mono text-base"
          >
            {result.diff.map((seg, idx) =>
              seg.op === 'equal' ? (
                <span key={idx} className="text-emerald-700 dark:text-emerald-300">
                  {seg.text}
                </span>
              ) : seg.op === 'delete' ? (
                <span
                  key={idx}
                  title="Expected"
                  className="rounded bg-amber-500/20 px-0.5 text-amber-800 underline decoration-dotted dark:text-amber-200"
                >
                  {seg.text}
                </span>
              ) : (
                <span
                  key={idx}
                  title="Extra / incorrect"
                  className="rounded bg-rose-500/20 px-0.5 text-rose-700 line-through dark:text-rose-300"
                >
                  {seg.text}
                </span>
              ),
            )}
          </div>

          {!result.correct && (
            <div className="text-xs text-[var(--muted)]">
              Expected: <strong className="text-[var(--fg)]">{result.matchedCandidate}</strong>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
