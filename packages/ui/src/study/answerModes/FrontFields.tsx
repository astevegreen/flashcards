import { noteField } from '@flash/core';
import { cardTextFitClass } from '../fitText.ts';
import { CardFieldValue } from './CardFieldValue.tsx';
import type { AnswerModeRenderProps } from './types.ts';

type ShellProps = Pick<
  AnswerModeRenderProps,
  'note' | 'deck' | 'layout' | 'fieldMetaByKey' | 'hideFrontRuby' | 'pinyinToneColors'
>;

export interface FrontFieldsProps extends ShellProps {
  /** Text size of the first field: `prompt` for flip-style fronts, `answer` above an input. */
  fit: 'prompt' | 'answer';
  /** Wrapper classes; defaults to the layout the answer modes share. */
  className?: string;
}

/**
 * The front fields of a card, shared by the lazy answer modes (R7). Flip keeps its own copy, so
 * this stays out of the initial bundle.
 */
export function FrontFields({
  note,
  deck,
  layout,
  fieldMetaByKey,
  hideFrontRuby,
  pinyinToneColors,
  fit,
  className = 'flex w-full max-w-2xl flex-col items-center gap-3 pt-4',
}: FrontFieldsProps) {
  return (
    <div className={className}>
      {layout.front_fields.map((fieldKey, idx) => {
        const value = noteField(note, fieldKey);
        if (!value) return null;
        return (
          <div
            key={fieldKey}
            data-testid={`front-field-${fieldKey}`}
            className={
              idx === 0
                ? `whitespace-pre-wrap font-semibold tracking-tight ${cardTextFitClass(value, fit, layout.ruby_display)}`
                : `whitespace-pre-wrap text-[var(--muted)] ${cardTextFitClass(value, 'detail', layout.ruby_display)}`
            }
          >
            <CardFieldValue
              fieldKey={fieldKey}
              value={value}
              meta={fieldMetaByKey.get(fieldKey)}
              fallbackLang={deck.language}
              hideRuby={hideFrontRuby}
              pinyinToneColors={pinyinToneColors}
            />
          </div>
        );
      })}
    </div>
  );
}
