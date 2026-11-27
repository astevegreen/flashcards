/**
 * Pure AST Ruby parser per blueprint §6.2.
 * Never produces HTML strings; UI renders `<ruby>` declaratively from these segments.
 *
 * Supported syntaxes:
 * 1. Strict `X[Y]`: only parsed when there is NO space before `[` AND the immediately
 *    preceding base run `X` consists solely of Han characters (CJK Unified Ideographs,
 *    Extensions A-G, CJK Compatibility Ideographs, and `々 〆 ヶ ヵ`).
 *    Examples:
 *    - `私の日本[にほん]` -> text("私の") + ruby("日本", "にほん")
 *    - `學[학]` -> ruby("學", "학")
 *    - `word [formal]` -> text("word [formal]") (untouched)
 *    - `test[abc]` -> text("test[abc]") (untouched)
 * 2. Explicit `{base|reading}` for any base (kana, ateji, Latin, etc.):
 *    - `{今日|きょう}` -> ruby("今日", "きょう")
 * 3. Per-character explicit `{日本|に|ほん}` when the number of reading parts equals
 *    the Unicode code point length of `base`:
 *    - `{日本|に|ほん}` -> ruby("日", "に") + ruby("本", "ほん")
 */

import type { RubyDisplay } from '../model/types.ts';

export type RubySegment =
  { type: 'text'; value: string } | { type: 'ruby'; base: string; reading: string };

/** Checks whether a Unicode code point is a Han/Kanji/Hanja character or CJK iteration mark. */
export function isHanCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0x20000 && cp <= 0x2a6df) || // CJK Extension B
    (cp >= 0x2a700 && cp <= 0x2b73f) || // CJK Extension C
    (cp >= 0x2b740 && cp <= 0x2b81f) || // CJK Extension D
    (cp >= 0x2b820 && cp <= 0x2ceaf) || // CJK Extension E
    (cp >= 0x2ceb0 && cp <= 0x2ebef) || // CJK Extension F
    (cp >= 0x30000 && cp <= 0x323af) || // CJK Extension G & H
    cp === 0x3005 || // 々
    cp === 0x3006 || // 〆
    cp === 0x30f5 || // ヵ
    cp === 0x30f6 // ヶ
  );
}

function pushText(segments: RubySegment[], value: string): void {
  if (!value) return;
  const last = segments[segments.length - 1];
  if (last && last.type === 'text') {
    last.value += value;
  } else {
    segments.push({ type: 'text', value });
  }
}

export function parseRuby(input: string): RubySegment[] {
  if (!input) return [];

  const chars = Array.from(input);
  const segments: RubySegment[] = [];
  let textBuf: string[] = [];

  const flushTextBuf = (): void => {
    if (textBuf.length > 0) {
      pushText(segments, textBuf.join(''));
      textBuf = [];
    }
  };

  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === undefined) break;

    // 1. Explicit {base|reading} or {base|r1|r2...}
    if (ch === '{') {
      let closeIdx = -1;
      for (let j = i + 1; j < chars.length; j++) {
        if (chars[j] === '}') {
          closeIdx = j;
          break;
        }
        if (chars[j] === '{' || chars[j] === '\n') {
          break;
        }
      }
      if (closeIdx !== -1) {
        const inner = chars.slice(i + 1, closeIdx).join('');
        const parts = inner.split('|');
        const base = parts[0] ?? '';
        const readings = parts.slice(1);
        if (parts.length >= 2 && base.length > 0 && readings.every((r) => r.length > 0)) {
          flushTextBuf();
          const baseChars = Array.from(base);
          if (readings.length > 1 && readings.length === baseChars.length) {
            for (let k = 0; k < baseChars.length; k++) {
              const baseChar = baseChars[k];
              const readingPart = readings[k];
              if (baseChar !== undefined && readingPart !== undefined) {
                segments.push({ type: 'ruby', base: baseChar, reading: readingPart });
              }
            }
          } else {
            segments.push({ type: 'ruby', base, reading: readings.join('') });
          }
          i = closeIdx + 1;
          continue;
        }
      }
      textBuf.push(ch);
      i += 1;
      continue;
    }

    // 2. Strict Han[reading] with NO space before '['
    if (ch === '[' && textBuf.length > 0) {
      // Find trailing contiguous Han run at the end of textBuf
      let hanStart = textBuf.length;
      while (hanStart > 0) {
        const prevChar = textBuf[hanStart - 1];
        const cp = prevChar?.codePointAt(0);
        if (cp !== undefined && isHanCodePoint(cp)) {
          hanStart -= 1;
        } else {
          break;
        }
      }

      if (hanStart < textBuf.length) {
        // Look for matching closing ']'
        let closeIdx = -1;
        for (let j = i + 1; j < chars.length; j++) {
          if (chars[j] === ']') {
            closeIdx = j;
            break;
          }
          if (chars[j] === '[' || chars[j] === '\n') {
            break;
          }
        }

        if (closeIdx > i + 1) {
          const reading = chars.slice(i + 1, closeIdx).join('');
          if (reading.trim().length > 0) {
            const prefix = textBuf.slice(0, hanStart).join('');
            const base = textBuf.slice(hanStart).join('');
            textBuf = [];
            if (prefix) pushText(segments, prefix);
            segments.push({ type: 'ruby', base, reading });
            i = closeIdx + 1;
            continue;
          }
        }
      }

      textBuf.push(ch);
      i += 1;
      continue;
    }

    textBuf.push(ch);
    i += 1;
  }

  flushTextBuf();
  return segments;
}

/**
 * Applies a layout's ruby display flag to parsed segments: `both` keeps the ruby, `readings`
 * shows each reading as plain text, `bases` shows each base as plain text. Adjacent text merges.
 */
export function applyRubyDisplay(
  segments: readonly RubySegment[],
  mode: RubyDisplay | undefined,
): RubySegment[] {
  if (mode === undefined || mode === 'both') return [...segments];
  const out: RubySegment[] = [];
  for (const seg of segments) {
    if (seg.type === 'ruby') pushText(out, mode === 'readings' ? seg.reading : seg.base);
    else pushText(out, seg.value);
  }
  return out;
}

/** Strips ruby readings and returns plain base text (useful for search indexing & sorting). */
export function stripRuby(input: string, display?: RubyDisplay): string {
  const showReadings = display === 'readings';
  return parseRuby(input)
    .map((seg) => {
      if (seg.type === 'text') return seg.value;
      return showReadings ? seg.reading : seg.base;
    })
    .join('');
}
