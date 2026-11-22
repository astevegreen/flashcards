import { isHanCodePoint } from '../../parsers/ruby.ts';

/**
 * Anki furigana (`{{furigana:Field}}`, `{{kana:…}}`, `{{kanji:…}}`) to this app's ruby syntax
 * (§6.2). Anki's rule: a ruby base runs from the previous space (or the start of the text, the
 * end of an HTML tag, or the previous ruby) up to `[`; the reading runs to the next `]`, and
 * one space in front of the base is markup that is not displayed. Readings starting with
 * `sound:` are audio tags, not furigana. Implemented as a scanner (no backtracking regex).
 */

const RUBY_SYNTAX_CHARS = ['{', '}', '|', '[', ']'];

function hasRubySyntax(text: string): boolean {
  return RUBY_SYNTAX_CHARS.some((ch) => text.includes(ch));
}

function isAllHan(text: string): boolean {
  for (const ch of text) {
    if (!isHanCodePoint(ch.codePointAt(0) ?? 0)) return false;
  }
  return text.length > 0;
}

function endsWithHan(text: string): boolean {
  const last = Array.from(text.slice(-2)).at(-1);
  return last !== undefined && isHanCodePoint(last.codePointAt(0) ?? 0);
}

/** True when `run[at]` and `run[at + 1]` are both `ch`. */
function isPair(run: string, at: number, ch: string): boolean {
  return run[at] === ch && run[at + 1] === ch;
}

/** Where the ruby base that ends at `open` starts (never before `floor`). */
function findBaseStart(run: string, floor: number, open: number): number {
  let k = open;
  while (k > floor) {
    if (run[k - 1] === ' ') break;
    // Cloze delimiters: Anki renders clozes to HTML before furigana, so they end a base.
    if (k - 2 >= floor && (isPair(run, k - 2, ':') || isPair(run, k - 2, '}'))) break;
    k -= 1;
  }
  return k;
}

/** Formats one converted ruby. `before` is the text already emitted in front of it. */
function formatRuby(base: string, reading: string, before: string): string {
  // Strict `漢字[かんじ]` only when the preceding text cannot extend the Han base.
  if (isAllHan(base) && !endsWithHan(before)) return `${base}[${reading}]`;
  return `{${base}|${reading}}`;
}

function isConvertible(base: string, reading: string): boolean {
  return (
    base.length > 0 &&
    reading.trim().length > 0 &&
    !reading.startsWith('sound:') &&
    !hasRubySyntax(base) &&
    !hasRubySyntax(reading)
  );
}

/**
 * Converts Anki furigana in one run of plain text (no HTML tags inside). Linear: the closing
 * `]` is looked up once per bracket pair, and a base never reaches back past the previous pair.
 */
export function convertAnkiFuriganaRun(run: string): string {
  if (!run.includes('[')) return run;
  let out = '';
  let emitted = 0;
  let floor = 0;
  let close = -1;
  let open = run.indexOf('[');
  while (open !== -1) {
    if (close <= open) close = run.indexOf(']', open + 1);
    if (close === -1) break;
    const nextOpen = run.indexOf('[', open + 1);
    if (nextOpen !== -1 && nextOpen < close) {
      open = nextOpen; // `[a[b]`: only the innermost `[b]` can be furigana
      continue;
    }
    const reading = run.slice(open + 1, close);
    const baseStart = findBaseStart(run, floor, open);
    const base = run.slice(baseStart, open);
    if (isConvertible(base, reading)) {
      let before = run.slice(emitted, baseStart);
      if (before.endsWith(' ')) before = before.slice(0, -1);
      out += before;
      out += formatRuby(base, reading, out);
      emitted = close + 1;
    }
    floor = close + 1;
    open = nextOpen;
  }
  return out + run.slice(emitted);
}
