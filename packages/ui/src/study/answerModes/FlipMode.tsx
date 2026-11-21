import { CardFieldValue, RevealedBackSteps } from './CardFieldValue.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';

function FlipModeView({
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
}: AnswerModeRenderProps) {
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

export const flipAnswerMode: AnswerModePlugin = {
  mode: 'flip',
  capturesFrontInteraction: false,
  render: (props) => <FlipModeView {...props} />,
};
