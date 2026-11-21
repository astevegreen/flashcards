import { lazy, Suspense } from 'react';
import { CardFieldValue, RevealedBackSteps } from './CardFieldValue.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';

const LazyTypedAnswerPanel = lazy(() => import('./TypedAnswerPanel.tsx'));

function TypedModeView({
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
  const populatedStep0 = nonMediaStep0.filter((k) => Boolean(note.fields[k]?.trim()));
  const answerFieldKey =
    layout.answer_field ??
    populatedStep0.find(
      (k) => k === 'meaning' || k === 'translation' || k === 'explanation' || k === 'word',
    ) ??
    populatedStep0[0] ??
    nonMediaStep0[0] ??
    step0[0] ??
    'meaning';

  const expectedRaw = note.fields[answerFieldKey] ?? '';
  const answerMeta = fieldMetaByKey.get(answerFieldKey);
  const answerLang = answerMeta?.lang ?? deck.language;

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

      <Suspense
        fallback={<div className="text-xs text-[var(--muted)]">Loading typed matcher…</div>}
      >
        <LazyTypedAnswerPanel
          cardId={card.id}
          expectedRaw={expectedRaw}
          lang={answerLang}
          isRevealed={isRevealed}
          placeholder={`Type ${answerMeta?.label ?? answerFieldKey}…`}
          onEvaluateAndReveal={onEvaluateAndReveal}
        />
      </Suspense>

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

export const typedAnswerMode: AnswerModePlugin = {
  mode: 'typed',
  capturesFrontInteraction: true,
  render: (props) => <TypedModeView {...props} />,
};
