/**
 * Pure editing helper for the field editor's bold / italic / colour toolbar and shortcuts.
 * Kept out of `parsers/` (which `apps/web/vite.config.ts` puts in the study-screen chunk) so it
 * ships in the lazy editor chunk.
 */
import {
  RICH_TEXT_COLORS,
  scanRichTextSpans,
  type RichTextMark,
  type RichTextSpanRange,
} from '../parsers/rich-text.ts';

export interface RichTextEdit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

const COLORS: readonly string[] = RICH_TEXT_COLORS;

function isColor(mark: RichTextMark): boolean {
  return COLORS.includes(mark);
}

/** Brace pairs, like brackets, as `open -> close`. */
function bracePairs(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') stack.push(i);
    else if (text[i] === '}') {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, i);
    }
  }
  return pairs;
}

/** The body of the innermost brace pair around `[from, closeAt]` when it is a cloze. */
function enclosingClozeBody(
  text: string,
  from: number,
  closeAt: number,
): { start: number; end: number } | null {
  let inner: [number, number] | null = null;
  for (const [open, close] of bracePairs(text)) {
    if (open < from && close > closeAt && (!inner || open > inner[0])) inner = [open, close];
  }
  if (!inner || text[inner[0] - 1] !== '{') return null;
  const header = /^c[1-9][0-9]?::/i.exec(text.slice(inner[0] + 1));
  if (!header) return null;
  return { start: inner[0] + 1 + header[0].length, end: inner[1] };
}

/**
 * Applies `mark` to the selection `[start, end)` of `text`:
 * - the selection is exactly a span's content, or the whole span: a span of the same mark is
 *   removed; a colour span given another colour changes colour;
 * - otherwise the selection is wrapped in `{mark:...}` (an empty selection inserts `{mark:}`
 *   with the caret inside).
 *
 * Returns `null` when the wrap would not form a span, e.g. a selection that cuts through ruby
 * or cloze braces, so the caller can leave the text alone and explain.
 */
export function toggleRichTextMark(
  text: string,
  start: number,
  end: number,
  mark: RichTextMark,
): RichTextEdit | null {
  const from = Math.max(0, Math.min(start, end, text.length));
  const to = Math.min(text.length, Math.max(start, end));
  const spans = scanRichTextSpans(text);

  const hit = spans.find(
    (s: RichTextSpanRange) =>
      (s.contentStart === from && s.close === to) || (s.open === from && s.close + 1 === to),
  );
  if (hit && (hit.mark === mark || (isColor(hit.mark) && isColor(mark)))) {
    const content = text.slice(hit.contentStart, hit.close);
    if (hit.mark === mark) {
      return {
        text: text.slice(0, hit.open) + content + text.slice(hit.close + 1),
        selectionStart: hit.open,
        selectionEnd: hit.open + content.length,
      };
    }
    const opener = `{${mark}:`;
    return {
      text: text.slice(0, hit.open) + opener + content + text.slice(hit.close),
      selectionStart: hit.open + opener.length,
      selectionEnd: hit.open + opener.length + content.length,
    };
  }

  const opener = `{${mark}:`;
  const selected = text.slice(from, to);
  const next = `${text.slice(0, from)}${opener}${selected}}${text.slice(to)}`;
  const contentStart = from + opener.length;
  if (selected.length === 0) {
    return { text: next, selectionStart: contentStart, selectionEnd: contentStart };
  }
  const closeAt = to + opener.length;
  const formedIn = (base: number, sub: string) =>
    scanRichTextSpans(sub).some((s) => s.open === from - base && s.close === closeAt - base);
  let formed = formedIn(0, next);
  if (!formed) {
    // Inside a cloze answer or hint the span is parsed again when the answer renders.
    const body = enclosingClozeBody(next, from, closeAt);
    formed = body !== null && formedIn(body.start, next.slice(body.start, body.end));
  }
  if (!formed) return null;
  return { text: next, selectionStart: contentStart, selectionEnd: contentStart + selected.length };
}
