import { isHanCodePoint } from './ruby.ts';

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
  if (!input || !input.includes('[')) return input;
  return input.replace(
    /(^|[ \u3000])([^\s[\]{}|]+)\[([^\][]+)\]/gu,
    (match, lead: string, base: string, reading: string) => {
      const cps = Array.from(base).map((c) => c.codePointAt(0) ?? 0);
      if (!cps.some(isHanCodePoint)) return match;
      if (cps.every(isHanCodePoint)) return `${base}[${reading}]`;
      if (cps.every((cp) => isHanCodePoint(cp) || isKanaCodePoint(cp))) {
        return `{${base}|${reading}}`;
      }
      // Mixed with Latin/punctuation: keep the space so nothing is glued together.
      return `${lead}{${base}|${reading}}`;
    },
  );
}
