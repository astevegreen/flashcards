import { parseRichText, type RichTextColor, type RichTextNode } from '../../parsers/rich-text.ts';
import type { AnkiRichTextConverter } from './field-html.ts';

/**
 * Light-theme shades of the `.rich-*` classes in `apps/web/src/styles.css`. Anki fields carry no
 * theme, so the light shades are written inline (they stay readable on Anki's dark mode too).
 */
export const ANKI_RICH_TEXT_COLORS: Readonly<Record<RichTextColor, string>> = {
  red: '#dc2626',
  orange: '#c2410c',
  green: '#15803d',
  blue: '#2563eb',
  purple: '#7c3aed',
};

function openTag(mark: string): string {
  if (mark === 'b' || mark === 'i') return `<${mark}>`;
  return `<span style="color: ${ANKI_RICH_TEXT_COLORS[mark as RichTextColor]}">`;
}

function closeTag(mark: string): string {
  return mark === 'b' || mark === 'i' ? `</${mark}>` : '</span>';
}

function render(nodes: readonly RichTextNode[], plain: (run: string) => string): string {
  let out = '';
  for (const node of nodes) {
    out +=
      node.type === 'text'
        ? plain(node.value)
        : `${openTag(node.mark)}${render(node.children, plain)}${closeTag(node.mark)}`;
  }
  return out;
}

/**
 * The default {@link AnkiRichTextConverter}: `{b:…}` becomes `<b>`, `{i:…}` `<i>` and the colours
 * `<span style="color: #…">`. Only text runs go through `plain` (HTML-escaped, ruby as Anki
 * furigana), so field text can never inject markup; the tags come from the fixed mark list.
 * Spans inside cloze answers are converted too (`{{c1::{b:word}}}` -> `{{c1::<b>word</b>}}`).
 * Text without markup takes the plain path unchanged.
 */
export const ankiRichTextToHtml: AnkiRichTextConverter = (text, plain) =>
  render(parseRichText(text, { throughCloze: true }), plain);
