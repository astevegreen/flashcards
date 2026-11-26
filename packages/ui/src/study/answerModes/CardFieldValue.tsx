import { parseMediaHashUri } from '@flash/core';
import { Suspense } from 'react';
import { lazyWithRetry } from '../../lazy/lazyWithRetry.tsx';
import { RichText } from '../../components/RichText.tsx';
import { useApp } from '../../state/AppContext.tsx';
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
