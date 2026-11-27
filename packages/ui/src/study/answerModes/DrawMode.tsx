import { noteField } from '@flash/core';
import {
  extractDrawableCharacters,
  resolveDrawingMode,
  resolveStrokeScriptForLang,
} from '@flash/core/drawing';
import type { HandwritingCandidate } from '@flash/platform';
import { Suspense, useEffect, useState } from 'react';
import { lazyWithRetry } from '../../lazy/lazyWithRetry.tsx';
import { DrawLookupPanel } from '../../drawing/DrawLookupPanel.tsx';
import { RevealedAnswer } from './AnswerShell.tsx';
import { FrontFields } from './FrontFields.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';

const LazyDrawQuizPanel = lazyWithRetry(() => import('../../drawing/DrawQuizPanel.tsx'));

function DrawModeView(props: AnswerModeRenderProps) {
  const {
    state,
    card,
    note,
    deck,
    layout,
    noteType,
    fieldMetaByKey,
    isRevealed,
    onEvaluateAndReveal,
  } = props;
  const step0 = layout.reveal_steps[0] ?? [];
  const nonMediaStep0 = step0.filter((k) => {
    const f = noteType?.fields.find((nf) => nf.key === k);
    return f?.kind !== 'image' && f?.kind !== 'audio';
  });
  const answerFieldKey =
    layout.answer_field ??
    nonMediaStep0.find((k) => k === 'word' || k === 'character' || k === 'hanja') ??
    nonMediaStep0[0] ??
    step0[0] ??
    'word';

  const expectedRaw = noteField(note, answerFieldKey) ?? '';
  const answerMeta = fieldMetaByKey.get(answerFieldKey);
  const answerLang = answerMeta?.lang ?? deck.language;
  const drawingMode = resolveDrawingMode(state.preferences, answerLang);
  const strokeScript = resolveStrokeScriptForLang(answerLang);
  const drawableChars = extractDrawableCharacters(expectedRaw, answerLang, {
    rubyDisplay: layout.ruby_display,
  });

  const [lookupCandidates, setLookupCandidates] = useState<readonly HandwritingCandidate[]>([]);
  const [selectedLookupChar, setSelectedLookupChar] = useState<string | null>(null);

  useEffect(() => {
    setLookupCandidates([]);
    setSelectedLookupChar(null);
  }, [card.id]);

  const handleLookupReveal = () => {
    const expectedFirst = drawableChars[0];
    const matched =
      Boolean(expectedFirst) &&
      (selectedLookupChar === expectedFirst ||
        lookupCandidates.slice(0, 3).some((c) => c.character === expectedFirst));
    onEvaluateAndReveal({
      correct: matched,
      suggestedRating: matched ? 3 : 1,
      ...(selectedLookupChar ? { typedAnswer: selectedLookupChar } : {}),
    });
  };

  return (
    <>
      <FrontFields
        {...props}
        fit="answer"
        className="flex w-full max-w-2xl flex-col items-center gap-2 pt-4"
      />

      {/* Drawing Surface by per-language mode (§6.4): graded | lookup | off */}
      {drawingMode === 'off' ? (
        <p data-testid="draw-mode-off-notice" className="text-xs text-[var(--muted)]">
          Drawing is set to Off for <strong>{answerLang}</strong> (change in Settings → Drawing).
          Tap Show Answer to study as Flip.
        </p>
      ) : drawableChars.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">
          No drawable CJK characters found in field “{answerMeta?.label ?? answerFieldKey}”. Tap
          Show Answer to reveal.
        </p>
      ) : drawingMode === 'graded' ? (
        <Suspense
          fallback={<div className="py-8 text-xs text-[var(--muted)]">Loading Hanzi Writer…</div>}
        >
          <LazyDrawQuizPanel
            cardId={card.id}
            characters={drawableChars}
            script={strokeScript}
            isRevealed={isRevealed}
            onEvaluateAndReveal={onEvaluateAndReveal}
          />
        </Suspense>
      ) : (
        <DrawLookupPanel
          key={card.id}
          lang={answerLang}
          size={220}
          disabled={isRevealed}
          onCandidatesChange={setLookupCandidates}
          onSelectCandidate={(ch) => setSelectedLookupChar(ch)}
          {...(!isRevealed
            ? {
                onReveal: handleLookupReveal,
                revealLabel: selectedLookupChar
                  ? `Reveal (picked ${selectedLookupChar})`
                  : 'Reveal Answer',
              }
            : {})}
          testIdPrefix="study-draw-lookup"
        />
      )}

      <RevealedAnswer {...props} />
    </>
  );
}

export const drawAnswerMode: AnswerModePlugin = {
  mode: 'draw',
  capturesFrontInteraction: true,
  render: (props) => <DrawModeView {...props} />,
};
