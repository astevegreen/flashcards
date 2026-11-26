import { RevealedAnswer } from './AnswerShell.tsx';
import { CardFieldValue } from './CardFieldValue.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';
import { cardTextFitClass } from '../fitText.ts';

function FlipModeView(props: AnswerModeRenderProps) {
  const {
    note,
    deck,
    layout,
    fieldMetaByKey,
    populatedRevealSteps,
    isRevealed,
    isFullyRevealed,
    hideFrontRuby,
    pinyinToneColors,
  } = props;
  const isExtrasOpen = isRevealed && populatedRevealSteps.length > 1 && isFullyRevealed;

  return (
    <>
      <div
        className={`flex w-full max-w-2xl flex-col items-center gap-3 transition-[padding] duration-200 ${
          isExtrasOpen ? 'pt-1' : 'pt-4'
        }`}
      >
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
                  ? `whitespace-pre-wrap font-semibold tracking-tight ${cardTextFitClass(value, 'prompt', layout.ruby_display)}`
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

      <RevealedAnswer {...props} />
    </>
  );
}

export const flipAnswerMode: AnswerModePlugin = {
  mode: 'flip',
  capturesFrontInteraction: false,
  render: (props) => <FlipModeView {...props} />,
};
