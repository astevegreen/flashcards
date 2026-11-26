import { useContext } from 'react';
import { RubyDisplayContext } from '../../components/RichText.tsx';
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
  /** `data-testid` prefix of each field. */
  testIdPrefix?: string;
}

/** The front fields of a card, shared by the answer modes (R7). */
export function FrontFields({
  note,
  deck,
  layout,
  fieldMetaByKey,
  hideFrontRuby,
  pinyinToneColors,
  fit,
  className = 'flex w-full max-w-2xl flex-col items-center gap-3 pt-4',
  testIdPrefix = 'front-field',
}: FrontFieldsProps) {
  return (
    <div className={className}>
      {layout.front_fields.map((fieldKey, idx) => {
        const value = note.fields[fieldKey];
        if (!value) return null;
        return (
          <div
            key={fieldKey}
            data-testid={`${testIdPrefix}-${fieldKey}`}
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

export interface RevealedAnswerProps extends Pick<
  AnswerModeRenderProps,
  | 'note'
  | 'deck'
  | 'layout'
  | 'fieldMetaByKey'
  | 'pinyinToneColors'
  | 'populatedRevealSteps'
  | 'revealStep'
  | 'isRevealed'
  | 'isFullyRevealed'
> {
  /** Repeat the front fields above the back steps (Listen hides them until reveal). */
  showFrontFields?: boolean;
}

/** The revealed back steps under every answer mode; nothing until the card is revealed (R7). */
export function RevealedAnswer({
  note,
  deck,
  layout,
  fieldMetaByKey,
  pinyinToneColors,
  populatedRevealSteps,
  revealStep,
  isRevealed,
  isFullyRevealed,
  showFrontFields,
}: RevealedAnswerProps) {
  const rubyDisplay = useContext(RubyDisplayContext);
  if (!isRevealed) return null;
  const { fields, tags } = note;
  const fallbackLang = deck.language;
  const visibleSteps = populatedRevealSteps.slice(0, revealStep);
  const hasExtrasPanel = populatedRevealSteps.length > 1 && isFullyRevealed;
  const mainSteps = hasExtrasPanel ? visibleSteps.slice(0, -1) : visibleSteps;
  const extrasStep = hasExtrasPanel ? visibleSteps.at(-1) : undefined;

  return (
    <div
      data-testid="card-back"
      className={`flex w-full max-w-2xl flex-col items-center border-t border-[var(--border)] ${
        hasExtrasPanel ? 'gap-3 pt-4' : 'gap-4 pt-6'
      }`}
    >
      {showFrontFields && (
        <FrontFields
          note={note}
          deck={deck}
          layout={layout}
          fieldMetaByKey={fieldMetaByKey}
          hideFrontRuby={false}
          pinyinToneColors={pinyinToneColors}
          fit="answer"
          className="flex w-full flex-col items-center gap-2"
          testIdPrefix="back-front-field"
        />
      )}

      {mainSteps.map((stepKeys, stepIdx) => (
        <div key={stepIdx} className="flex w-full flex-col items-center gap-2">
          {stepKeys.map((fieldKey) => {
            const value = fields[fieldKey];
            if (!value) return null;
            const meta = fieldMetaByKey.get(fieldKey);
            const isPrimaryBack =
              stepIdx === 0 &&
              (fieldKey === 'meaning' ||
                fieldKey === 'word' ||
                fieldKey === 'translation' ||
                fieldKey === 'explanation');
            return (
              <div
                key={fieldKey}
                data-testid={`back-field-${fieldKey}`}
                className={
                  isPrimaryBack
                    ? `whitespace-pre-wrap font-medium ${cardTextFitClass(value, 'answer', rubyDisplay)}`
                    : fieldKey === 'reading' || fieldKey === 'hanja' || fieldKey === 'eumhun'
                      ? `whitespace-pre-wrap text-[var(--accent)] ${cardTextFitClass(value, 'answer', rubyDisplay)}`
                      : `whitespace-pre-wrap text-[var(--muted)] ${cardTextFitClass(value, 'detail', rubyDisplay)}`
                }
              >
                <CardFieldValue
                  fieldKey={fieldKey}
                  value={value}
                  meta={meta}
                  fallbackLang={fallbackLang}
                  hideRuby={false}
                  pinyinToneColors={pinyinToneColors}
                />
              </div>
            );
          })}
        </div>
      ))}

      {extrasStep && (
        <div
          data-testid="card-extras-panel"
          className="card-extras-panel flex w-full flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]/70 px-4 py-3.5 text-left sm:px-5 sm:py-4"
        >
          {extrasStep.map((fieldKey) => {
            const value = fields[fieldKey];
            if (!value) return null;
            const meta = fieldMetaByKey.get(fieldKey);
            return (
              <div
                key={fieldKey}
                data-testid={`back-field-${fieldKey}`}
                className="flex flex-col gap-0.5"
              >
                {meta?.label && (
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                    {meta.label}
                  </span>
                )}
                <div
                  className={`whitespace-pre-wrap text-[var(--fg)] ${cardTextFitClass(value, 'detail', rubyDisplay)}`}
                >
                  <CardFieldValue
                    fieldKey={fieldKey}
                    value={value}
                    meta={meta}
                    fallbackLang={fallbackLang}
                    hideRuby={false}
                    pinyinToneColors={pinyinToneColors}
                  />
                </div>
              </div>
            );
          })}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 text-xs text-[var(--muted)]"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {!extrasStep && tags.length > 0 && isFullyRevealed && (
        <div className="flex flex-wrap justify-center gap-1.5 pt-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-xs text-[var(--muted)]"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
