import { generateChoiceOptions } from '@flash/core/choice';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RichText } from '../../components/RichText.tsx';
import { useApp } from '../../state/AppContext.tsx';
import { CardFieldValue, RevealedBackSteps } from './CardFieldValue.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';

function ChoiceModeView({
  state,
  card,
  note,
  deck,
  layout,
  fieldMetaByKey,
  populatedRevealSteps,
  revealStep,
  isRevealed,
  isFullyRevealed,
  hideFrontRuby,
  pinyinToneColors,
  studyDayIndex,
  onEvaluateAndReveal,
}: AnswerModeRenderProps) {
  const { stateVersion } = useApp();
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedOptionId(null);
  }, [card.id]);

  const question = useMemo(
    () => generateChoiceOptions(state, card, studyDayIndex),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, card.id, studyDayIndex],
  );

  const handleSelectOption = useCallback(
    (optionId: string, isCorrect: boolean) => {
      if (isRevealed) return;
      setSelectedOptionId(optionId);
      onEvaluateAndReveal({
        correct: isCorrect,
        suggestedRating: isCorrect ? 3 : 1,
      });
    },
    [isRevealed, onEvaluateAndReveal],
  );

  // Keyboard shortcuts `1`..`4` to select choices while unrevealed (§5.2)
  useEffect(() => {
    if (isRevealed || question.options.length < 2) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          e.target.isContentEditable ||
          e.target.closest('dialog[open]')
        ) {
          return;
        }
      }
      const idx = Number(e.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < question.options.length) {
        const opt = question.options[idx];
        if (opt) {
          e.preventDefault();
          handleSelectOption(opt.id, opt.isCorrect);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSelectOption, isRevealed, question.options]);

  const selectedOption = question.options.find((o) => o.id === selectedOptionId);

  return (
    <>
      <div className="flex w-full max-w-2xl flex-col items-center gap-3 pt-4">
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
                  ? 'whitespace-pre-wrap text-3xl font-semibold leading-snug tracking-tight sm:text-5xl'
                  : 'whitespace-pre-wrap text-lg text-[var(--muted)] sm:text-xl'
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

      {question.options.length >= 2 ? (
        <div
          data-testid="choice-options"
          className="grid w-full max-w-xl grid-cols-1 gap-2.5 sm:grid-cols-2"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          {question.options.map((opt, idx) => {
            const isSelected = selectedOptionId === opt.id;
            let stateClasses =
              'border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]';
            if (isRevealed) {
              if (opt.isCorrect) {
                stateClasses =
                  'border-emerald-500 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200';
              } else if (isSelected && !opt.isCorrect) {
                stateClasses = 'border-rose-500 bg-rose-500/15 text-rose-800 dark:text-rose-200';
              } else {
                stateClasses =
                  'border-[var(--border)] bg-[var(--bg)] text-[var(--muted)] opacity-60';
              }
            }

            return (
              <button
                key={opt.id}
                type="button"
                data-testid={`choice-option-${idx + 1}`}
                data-correct={opt.isCorrect ? 'true' : 'false'}
                disabled={isRevealed}
                onClick={() => handleSelectOption(opt.id, opt.isCorrect)}
                className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-left text-sm font-medium transition-colors ${stateClasses}`}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current/30 text-xs font-bold tabular-nums">
                  {idx + 1}
                </span>
                <span className="min-w-0 flex-1 break-words">
                  <RichText
                    text={opt.text}
                    lang={opt.lang}
                    hideRuby={false}
                    pinyinToneColors={pinyinToneColors}
                  />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-[var(--muted)]">
          Add more notes to this deck for 4-option multiple choice (tap Show Answer to reveal).
        </p>
      )}

      {isRevealed && selectedOption && (
        <div
          data-testid="choice-feedback"
          className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
            selectedOption.isCorrect
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
          }`}
        >
          {selectedOption.isCorrect
            ? 'Correct ✓ · Suggested: Good'
            : 'Incorrect · Suggested: Again'}
        </div>
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

export const choiceAnswerMode: AnswerModePlugin = {
  mode: 'choice',
  capturesFrontInteraction: true,
  render: (props) => <ChoiceModeView {...props} />,
};
