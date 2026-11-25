import { parseMediaHashUri } from '@flash/core';
import { Suspense, useContext } from 'react';
import { lazyWithRetry } from '../../lazy/lazyWithRetry.tsx';
import { RichText, RubyDisplayContext } from '../../components/RichText.tsx';
import { useApp } from '../../state/AppContext.tsx';
import { cardTextFitClass } from '../fitText.ts';
import type { FieldMeta } from './types.ts';

const LazyMediaAudioPlayer = lazyWithRetry(
  () =>
    import('../../components/MediaAudioPlayer.tsx').then((m) => ({ default: m.MediaAudioPlayer })),
  { quiet: true },
);
const LazyMediaImage = lazyWithRetry(
  () => import('../../components/MediaImage.tsx').then((m) => ({ default: m.MediaImage })),
  { quiet: true },
);

export interface CardFieldValueProps {
  fieldKey: string;
  value: string;
  meta: FieldMeta | undefined;
  fallbackLang: string;
  hideRuby: boolean;
  pinyinToneColors: boolean;
}

export function CardFieldValue({
  fieldKey,
  value,
  meta,
  fallbackLang,
  hideRuby,
  pinyinToneColors,
}: CardFieldValueProps) {
  const { state } = useApp();
  if (!value) return null;
  const mediaHash = parseMediaHashUri(value);
  const isAudioBlob = Boolean(mediaHash && state.media.get(mediaHash)?.mime.startsWith('audio/'));
  if (meta?.kind === 'audio' || fieldKey === 'audio' || isAudioBlob) {
    return (
      <div className="flex justify-center">
        <Suspense fallback={null}>
          <LazyMediaAudioPlayer src={value} label={meta?.label ?? 'Audio clip'} />
        </Suspense>
      </div>
    );
  }
  if (meta?.kind === 'image' || mediaHash !== null) {
    return (
      <div className="flex justify-center">
        <Suspense fallback={null}>
          <LazyMediaImage src={value} alt={meta?.label ?? 'Card image'} />
        </Suspense>
      </div>
    );
  }
  return (
    <RichText
      text={value}
      lang={meta?.lang ?? fallbackLang}
      hideRuby={hideRuby}
      pinyinToneColors={pinyinToneColors}
    />
  );
}

export interface RevealedBackStepsProps {
  populatedRevealSteps: readonly (readonly string[])[];
  revealStep: number;
  isFullyRevealed: boolean;
  fields: Readonly<Record<string, string>>;
  tags: readonly string[];
  fieldMetaByKey: ReadonlyMap<string, FieldMeta>;
  fallbackLang: string;
  pinyinToneColors: boolean;
  /** Optional extra front fields to show on back (used by ListenMode). */
  extraFrontFields?: readonly string[];
}

export function RevealedBackSteps({
  populatedRevealSteps,
  revealStep,
  isFullyRevealed,
  fields,
  tags,
  fieldMetaByKey,
  fallbackLang,
  pinyinToneColors,
  extraFrontFields,
}: RevealedBackStepsProps) {
  const rubyDisplay = useContext(RubyDisplayContext);
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
      {extraFrontFields && extraFrontFields.length > 0 && (
        <div className="flex w-full flex-col items-center gap-2">
          {extraFrontFields.map((fieldKey, idx) => {
            const value = fields[fieldKey];
            if (!value) return null;
            const meta = fieldMetaByKey.get(fieldKey);
            return (
              <div
                key={`front-reveal-${fieldKey}`}
                data-testid={`back-front-field-${fieldKey}`}
                className={
                  idx === 0
                    ? `whitespace-pre-wrap font-semibold ${cardTextFitClass(value, 'answer', rubyDisplay)}`
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
