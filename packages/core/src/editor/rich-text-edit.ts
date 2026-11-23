/**
 * Pure editing helper for the field editor's bold / italic / colour toolbar and shortcuts.
 * Kept out of `parsers/` (which `apps/web/vite.config.ts` puts in the study-screen chunk) so it
 * ships in the lazy editor chunk.
 */
import { isHanCodePoint } from '../parsers/ruby.ts';
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

/** A strict ruby group `学生[がくせい]`: Han base from `start`, `[` at `bracket`, `]` before `end`. */
interface StrictRubyGroup {
  start: number;
  bracket: number;
  end: number;
}

/** Strict `Han[reading]` groups, by the same rule as `parseRuby` (no space before `[`). */
function strictRubyGroups(text: string): StrictRubyGroup[] {
  const groups: StrictRubyGroup[] = [];
  for (let k = text.indexOf('['); k !== -1; k = text.indexOf('[', k + 1)) {
    let start = k;
    while (start > 0) {
      const low = text.charCodeAt(start - 1);
      const p = low >= 0xdc00 && low <= 0xdfff && start > 1 ? start - 2 : start - 1;
      if (!isHanCodePoint(text.codePointAt(p) ?? 0)) break;
      start = p;
    }
    if (start === k) continue;
    let j = k + 1;
    while (j < text.length && text[j] !== ']' && text[j] !== '[' && text[j] !== '\n') j++;
    if (text[j] !== ']' || text.slice(k + 1, j).trim().length === 0) continue;
    groups.push({ start, bracket: k, end: j + 1 });
  }
  return groups;
}

/**
 * Grows `[from, to)` over any strict ruby group it touches only in the base, so bolding `学生` in
 * `学生[がくせい]` styles the whole group and the reading stays attached. `null` when an end
 * falls inside the `[reading]`, or a caret sits inside a group.
 */
function coverStrictRuby(text: string, from: number, to: number): [number, number] | null {
  for (const g of strictRubyGroups(text)) {
    if (from === to) {
      if (from > g.start && from < g.end) return null;
      continue;
    }
    if (to <= g.start || from >= g.end) continue;
    if ((from >= g.bracket && from < g.end) || (to > g.bracket && to < g.end)) return null;
    if (from > g.start) from = g.start;
    if (to <= g.bracket) to = g.end;
  }
  return [from, to];
}

/**
 * Applies `mark` to the selection `[start, end)` of `text`:
 * - the selection is exactly a span's content, or the whole span: a span of the same mark is
 *   removed; a colour span given another colour changes colour;
 * - otherwise the selection is wrapped in `{mark:...}` (an empty selection inserts `{mark:}`
 *   with the caret inside). A selection of a strict ruby base grows over its `[reading]`.
 *
 * Returns `null` when the wrap would not form a span: a selection or caret that cuts through
 * ruby or cloze braces or a `[reading]`, or crosses a cloze's `::` hint separator. The caller
 * leaves the text alone and explains.
 */
export function toggleRichTextMark(
  text: string,
  start: number,
  end: number,
  mark: RichTextMark,
): RichTextEdit | null {
  const covered = coverStrictRuby(
    text,
    Math.max(0, Math.min(start, end, text.length)),
    Math.min(text.length, Math.max(start, end)),
  );
  if (!covered) return null;
  const [from, to] = covered;
  // Spans inside cloze answers count too, so a bold cloze answer can be toggled off.
  const spans = scanRichTextSpans(text, { throughCloze: true });

  // The innermost span on exactly this range whose mark this toggle can remove or recolour.
  const onRange = spans.filter(
    (s: RichTextSpanRange) =>
      (s.contentStart === from && s.close === to) || (s.open === from && s.close + 1 === to),
  );
  const hit =
    onRange.findLast((s) => s.mark === mark) ??
    (isColor(mark) ? onRange.findLast((s) => isColor(s.mark)) : undefined);
  if (hit) {
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
  // An empty span never parses, so check the caret position with a stand-in character.
  const probeContent = selected || 'x';
  const probe = `${text.slice(0, from)}${opener}${probeContent}}${text.slice(to)}`;
  const closeAt = from + opener.length + probeContent.length;
  const formedIn = (base: number, sub: string) =>
    scanRichTextSpans(sub).some((s) => s.open === from - base && s.close === closeAt - base);
  let formed = formedIn(0, probe);
  if (!formed) {
    // Inside a cloze answer or hint the span is parsed again when the answer renders, but it
    // must not cross the `::` before the hint (that would hide the hint).
    const body = enclosingClozeBody(probe, from, closeAt);
    formed =
      body !== null &&
      !selected.includes('::') &&
      formedIn(body.start, probe.slice(body.start, body.end));
  }
  if (!formed) return null;
  return { text: next, selectionStart: contentStart, selectionEnd: contentStart + selected.length };
}
