import {
  extractDrawableCharacters,
  resolveDrawingMode,
  resolveStrokeScriptForLang,
} from '@flash/core/drawing';
import type { HandwritingCandidate } from '@flash/platform';
import { Suspense, useEffect, useState } from 'react';
import { lazyWithRetry } from '../../lazy/lazyWithRetry.tsx';
import { DrawLookupPanel } from '../../drawing/DrawLookupPanel.tsx';
import { CardFieldValue, RevealedBackSteps } from './CardFieldValue.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';
import { cardTextFitClass } from '../fitText.ts';

const LazyDrawQuizPanel = lazyWithRetry(() => import('../../drawing/DrawQuizPanel.tsx'));

function DrawModeView({
  state,
  card,
  note,
  deck,
  layout,
  noteType,
  fieldMetaByKey,
  populatedRevealSteps,
  revealStep,
  isRevealed,
  isFullyRevealed,
  hideFrontRuby,
  pinyinToneColors,
  onEvaluateAndReveal,
}: AnswerModeRenderProps) {
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

  const expectedRaw = note.fields[answerFieldKey] ?? '';
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
      {/* Front Prompt Fields */}
      <div className="flex w-full max-w-2xl flex-col items-center gap-2 pt-4">
        {layout.front_fields.map((fieldKey, idx) => {
          const value = note.fields[fieldKey];
          if (!value) return null;
          const meta = fieldMetaByKey.get(fieldKey);
          return (
            <div
              key={fieldKey}
              data-testid={`front-field-${fieldKey}`}
              className={
                idx === 0
                  ? `whitespace-pre-wrap font-semibold tracking-tight ${cardTextFitClass(value, 'answer', layout.ruby_display)}`
                  : `whitespace-pre-wrap text-[var(--muted)] ${cardTextFitClass(value, 'detail', layout.ruby_display)}`
              }
            >
              <CardFieldValue
                fieldKey={fieldKey}
                value={value}
                meta={meta}
                fallbackLang={deck.language}
                hideRuby={hideFrontRuby}
                pinyinToneColors={pinyinToneColors}
              />
            </div>
          );
        })}
      </div>

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

      {isRevealed && (
        <RevealedBackSteps
          populatedRevealSteps={populatedRevealSteps}
          revealStep={revealStep}
          isFullyRevealed={isFullyRevealed}
          fields={note.fields}
          tags={note.tags}
          fieldMetaByKey={fieldMetaByKey}
          fallbackLang={deck.language}
          pinyinToneColors={pinyinToneColors}
        />
      )}
    </>
  );
}

export const drawAnswerMode: AnswerModePlugin = {
  mode: 'draw',
  capturesFrontInteraction: true,
  render: (props) => <DrawModeView {...props} />,
};
