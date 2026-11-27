import { isHanCodePoint } from '../parsers/ruby.ts';

/** Anki import only, so it stays out of the ruby parser the study screen loads (§8). */
function isKanaCodePoint(cp: number): boolean {
  return (cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff) || cp === 0x30fc;
}

/**
 * Converts Anki's space-delimited furigana (`私は 日本語[にほんご]を 食べる[たべる]`) into this
 * app's ruby syntax (§6.2 "Anki import"). In Anki a space (or the start of the text) marks where
 * a ruby base begins and is consumed by the markup:
 * - an all-Han base becomes strict `日本語[にほんご]` (the delimiter space is dropped);
 * - a base mixing Han with kana becomes explicit `{食べる|たべる}`;
 * - anything without a Han character (English `word [formal]`, `test[abc]`) is left untouched.
 */
export function convertAnkiRuby(input: string): string {
  if (!input?.includes('[')) return input;
  // A single left-to-right scan instead of a regular expression: imported text is untrusted, and
  // a pattern whose reading may span spaces backtracks quadratically on unclosed brackets.
  const n = input.length;
  // The first '[' or ']' at or after each index, so a reading is found in O(1).
  const nextBracket = new Int32Array(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    const c = input[i];
    nextBracket[i] = c === '[' || c === ']' ? i : (nextBracket[i + 1] ?? n);
  }
  const matchAt = (baseStart: number): { base: string; reading: string; end: number } | null => {
    let j = baseStart;
    while (j < n && !NOT_BASE.test(input[j] ?? ' ')) j++;
    if (j === baseStart || input[j] !== '[') return null;
    const k = nextBracket[j + 1] ?? n;
    if (k === j + 1 || input[k] !== ']') return null;
    return { base: input.slice(baseStart, j), reading: input.slice(j + 1, k), end: k + 1 };
  };
  let out = '';
  let copied = 0;
  let i = 0;
  while (i < n) {
    const ch = input[i] ?? '';
    let lead = '';
    let m = i === 0 ? matchAt(0) : null;
    if (!m && (ch === ' ' || ch === IDEOGRAPHIC_SPACE)) {
      lead = ch;
      m = matchAt(i + 1);
    }
    if (!m) {
      i++;
      continue;
    }
    out += input.slice(copied, i) + convertBase(lead, m.base, m.reading);
    copied = i = m.end;
  }
  return out + input.slice(copied);
}

/** A character a ruby base cannot hold: whitespace, brackets, braces or a pipe. */
const NOT_BASE = /[\s[\]{}|]/u;

/** The ideographic space, which also starts a base in Anki text. */
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

function convertBase(lead: string, base: string, reading: string): string {
  const cps = Array.from(base).map((c) => c.codePointAt(0) ?? 0);
  if (!cps.some(isHanCodePoint)) return `${lead}${base}[${reading}]`;
  if (cps.every(isHanCodePoint)) return `${base}[${reading}]`;
  if (cps.every((cp) => isHanCodePoint(cp) || isKanaCodePoint(cp))) {
    return `{${base}|${reading}}`;
  }
  // Mixed with Latin/punctuation: keep the space so nothing is glued together.
  return `${lead}{${base}|${reading}}`;
}
