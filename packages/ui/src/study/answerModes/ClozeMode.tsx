import {
  extractClozeAnswersForVariant,
  parseCloze,
  parseRichText,
  stripRichText,
  noteField,
} from '@flash/core';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { lazyWithRetry } from '../../lazy/lazyWithRetry.tsx';
import { RichText, renderRichNodes } from '../../components/RichText.tsx';
import { RevealedAnswer } from './AnswerShell.tsx';
import { CardFieldValue } from './CardFieldValue.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';
import { cardTextFitClass } from '../fitText.ts';

const LazyTypedAnswerPanel = lazyWithRetry(() => import('./TypedAnswerPanel.tsx'));

interface ClozeTextProps {
  text: string;
  activeVariant: number;
  revealed: boolean;
  lang: string;
  hideRuby: boolean;
  pinyinToneColors: boolean;
}

function ClozeText({
  text,
  activeVariant,
  revealed,
  lang,
  hideRuby,
  pinyinToneColors,
}: ClozeTextProps) {
  // Bold/italic/colour spans first, so `{b:{{c1::word}}}` keeps its blank; cloze answers render
  // through RichText again, so `{{c1::{b:word}}}` reveals in bold.
  const leaf = (value: string, keyPrefix: string): ReactNode[] =>
    parseCloze(value).map((seg, i) => {
      const idx = `${keyPrefix}${i}`;
      if (seg.type === 'text') {
        return (
          <RichText
            key={idx}
            text={seg.value}
            lang={lang}
            hideRuby={hideRuby}
            pinyinToneColors={pinyinToneColors}
          />
        );
      }
      const isActiveBlank = activeVariant === 0 || seg.index === activeVariant;
      if (!isActiveBlank) {
        return (
          <RichText
            key={idx}
            text={seg.answer}
            lang={lang}
            hideRuby={hideRuby}
            pinyinToneColors={pinyinToneColors}
          />
        );
      }
      if (!revealed) {
        return (
          <span
            key={idx}
            data-testid={`cloze-blank-c${seg.index}`}
            className="mx-1 inline-block rounded-lg border-2 border-[var(--accent)] bg-[var(--accent-soft)] px-2.5 py-0.5 text-[0.85em] font-bold text-[var(--accent)]"
          >
            {seg.hint ? `[${stripRichText(seg.hint)}]` : '[…]'}
          </span>
        );
      }
      return (
        <span
          key={idx}
          data-testid={`cloze-revealed-c${seg.index}`}
          className="mx-0.5 inline-block rounded-lg bg-emerald-500/15 px-1.5 py-0.5 font-bold text-emerald-700 dark:text-emerald-300"
        >
          <RichText
            text={seg.answer}
            lang={lang}
            hideRuby={false}
            pinyinToneColors={pinyinToneColors}
          />
        </span>
      );
    });
  return <span lang={lang}>{renderRichNodes(parseRichText(text), leaf, '')}</span>;
}

function ClozeModeView(props: AnswerModeRenderProps) {
  const {
    card,
    note,
    deck,
    layout,
    fieldMetaByKey,
    isRevealed,
    hideFrontRuby,
    pinyinToneColors,
    onEvaluateAndReveal,
  } = props;
  const [typedOverride, setTypedOverride] = useState<boolean | null>(null);
  useEffect(() => {
    setTypedOverride(null);
  }, [card.id]);

  const useTypedCloze = typedOverride ?? Boolean(layout.cloze_typed);

  const activeAnswers: string[] = [];
  let answerLang = deck.language;
  let foundAnswerField = false;
  for (const fieldKey of layout.front_fields) {
    const val = noteField(note, fieldKey);
    if (!val) continue;
    const answers = extractClozeAnswersForVariant(val, card.variant);
    if (answers.length > 0) {
      if (!foundAnswerField) {
        answerLang = fieldMetaByKey.get(fieldKey)?.lang ?? deck.language;
        foundAnswerField = true;
      }
      activeAnswers.push(...answers);
    }
  }
  const uniqueAnswers = [...new Set(activeAnswers.map((a) => a.trim()).filter(Boolean))];
  const expectedBlank =
    uniqueAnswers.length <= 1 ? (uniqueAnswers[0] ?? '') : activeAnswers.join(' ');

  return (
    <>
      <div className="flex w-full max-w-2xl flex-col items-center gap-3 pt-4">
        {layout.front_fields.map((fieldKey, idx) => {
          const value = noteField(note, fieldKey);
          if (!value) return null;
          const meta = fieldMetaByKey.get(fieldKey);
          const lang = meta?.lang ?? deck.language;
          if (meta?.kind === 'image' || /^media:[0-9a-f]{64}$/i.test(value.trim())) {
            return (
              <div key={fieldKey} data-testid={`front-field-${fieldKey}`}>
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
          }
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
              <ClozeText
                text={value}
                activeVariant={card.variant}
                revealed={isRevealed}
                lang={lang}
                hideRuby={hideFrontRuby}
                pinyinToneColors={pinyinToneColors}
              />
            </div>
          );
        })}

        {expectedBlank && !isRevealed && (
          <button
            type="button"
            data-testid="cloze-toggle-typed"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setTypedOverride(!useTypedCloze);
            }}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--fg)]"
          >
            {useTypedCloze ? 'Switch to Flip Cloze' : 'Type Blank Answer'}
          </button>
        )}
      </div>

      {useTypedCloze && expectedBlank && (
        <Suspense
          fallback={<div className="text-xs text-[var(--muted)]">Loading typed matcher…</div>}
        >
          <LazyTypedAnswerPanel
            cardId={card.id}
            expectedRaw={expectedBlank}
            lang={answerLang}
            isRevealed={isRevealed}
            placeholder="Type missing blank…"
            onEvaluateAndReveal={onEvaluateAndReveal}
          />
        </Suspense>
      )}

      <RevealedAnswer {...props} />
    </>
  );
}

export const clozeAnswerMode: AnswerModePlugin = {
  mode: 'cloze',
  capturesFrontInteraction: false,
  render: (props) => <ClozeModeView {...props} />,
};
