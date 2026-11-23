import {
  applyRubyDisplay,
  parsePinyin,
  parseRichText,
  parseRuby,
  type RichTextNode,
  type RubyDisplay,
} from '@flash/core';
import { createContext, memo, useContext, type ReactNode } from 'react';

/** The studied layout's ruby flag; screens outside a study card keep the default (`both`). */
export const RubyDisplayContext = createContext<RubyDisplay>('both');

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
 * Declaratively renders ruby (`<ruby>`), tone-marked Pinyin and bold/italic/colour spans from pure
 * AST tokens.
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
  const rubyDisplay = useContext(RubyDisplayContext);
  if (!text) return null;

  const leaf = (value: string, keyPrefix: string): ReactNode[] => {
    if (lang === 'zh-Latn-pinyin') {
      return parsePinyin(value).map((tok, idx) =>
        pinyinToneColors && tok.tone >= 1 && tok.tone <= 5 ? (
          <span key={`${keyPrefix}${idx}`} className={TONE_CLASS[tok.tone]}>
            {tok.text}
          </span>
        ) : (
          <span key={`${keyPrefix}${idx}`}>{tok.text}</span>
        ),
      );
    }
    return applyRubyDisplay(parseRuby(value), rubyDisplay).map((seg, idx) =>
      seg.type === 'ruby' ? (
        <ruby key={`${keyPrefix}${idx}`}>
          {seg.base}
          {!hideRuby && <rt>{seg.reading}</rt>}
        </ruby>
      ) : (
        <span key={`${keyPrefix}${idx}`}>{seg.value}</span>
      ),
    );
  };

  return (
    <span lang={lang} className={className}>
      {renderRichNodes(parseRichText(text), leaf, '')}
    </span>
  );
});

/**
 * Bold, italic and colour spans (`{b:...}`, `{i:...}`, `{red:...}`) as React elements; every text
 * leaf goes through `leaf` (ruby or pinyin). Text without spans renders exactly as before.
 */
export function renderRichNodes(
  nodes: readonly RichTextNode[],
  leaf: (value: string, keyPrefix: string) => ReactNode[],
  keyPrefix: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, idx) => {
    const key = `${keyPrefix}${idx}.`;
    if (node.type === 'text') {
      out.push(...leaf(node.value, nodes.length === 1 ? keyPrefix : key));
      return;
    }
    const children = renderRichNodes(node.children, leaf, key);
    if (node.mark === 'b') out.push(<strong key={key}>{children}</strong>);
    else if (node.mark === 'i') out.push(<em key={key}>{children}</em>);
    else
      out.push(
        <span key={key} className={`rich-${node.mark}`} data-rich-color={node.mark}>
          {children}
        </span>,
      );
  });
  return out;
}
