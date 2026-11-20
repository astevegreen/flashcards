import { parsePinyin, parseRuby } from '@flash/core';
import { memo } from 'react';

export interface RichTextProps {
  text: string;
  lang: string;
  hideRuby?: boolean;
  pinyinToneColors?: boolean;
  className?: string;
}

const TONE_CLASS: Record<number, string> = {
  1: 'pinyin-tone-1',
  2: 'pinyin-tone-2',
  3: 'pinyin-tone-3',
  4: 'pinyin-tone-4',
  5: 'pinyin-tone-5',
};

/**
 * Declaratively renders ruby (`<ruby>`) and tone-marked Pinyin from pure AST tokens.
 * Zero raw HTML / dangerouslySetInnerHTML (§13).
 * Explicit `lang` attribute preserves proper CJK Han unification glyph forms (§6.1).
 */
export const RichText = memo(function RichText({
  text,
  lang,
  hideRuby = false,
  pinyinToneColors = true,
  className,
}: RichTextProps) {
  if (!text) return null;

  if (lang === 'zh-Latn-pinyin') {
    const tokens = parsePinyin(text);
    return (
      <span lang={lang} className={className}>
        {tokens.map((tok, idx) =>
          pinyinToneColors && tok.tone >= 1 && tok.tone <= 5 ? (
            <span key={idx} className={TONE_CLASS[tok.tone]}>
              {tok.text}
            </span>
          ) : (
            <span key={idx}>{tok.text}</span>
          ),
        )}
      </span>
    );
  }

  const segments = parseRuby(text);
  return (
    <span lang={lang} className={className}>
      {segments.map((seg, idx) =>
        seg.type === 'ruby' ? (
          <ruby key={idx}>
            {seg.base}
            {!hideRuby && <rt>{seg.reading}</rt>}
          </ruby>
        ) : (
          <span key={idx}>{seg.value}</span>
        ),
      )}
    </span>
  );
});
