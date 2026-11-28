/** Characters looked at before guessing; enough for a column of sentences. */
const SAMPLE_LIMIT = 4000;

/** How many characters of each script some text holds (see {@link countScripts}). */
export interface ScriptCounts {
  kana: number;
  hangul: number;
  han: number;
  latin: number;
}

/** The script of one code point, or `undefined` for anything else. */
function scriptOf(cp: number): keyof ScriptCounts | undefined {
  if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) return 'kana';
  if ((cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1100 && cp <= 0x11ff)) return 'hangul';
  if (cp >= 0x4e00 && cp <= 0x9fff) return 'han';
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'latin';
  return undefined;
}

/**
 * Counts kana, Hangul, Han and basic Latin letters in the first {@link SAMPLE_LIMIT} characters
 * of `texts`. Other characters (digits, punctuation, spaces) count towards the limit only.
 */
export function countScripts(texts: Iterable<string>): ScriptCounts {
  const counts: ScriptCounts = { kana: 0, hangul: 0, han: 0, latin: 0 };
  let seen = 0;
  for (const text of texts) {
    for (const ch of text) {
      const script = scriptOf(ch.codePointAt(0) ?? 0);
      if (script) counts[script]++;
      if (++seen >= SAMPLE_LIMIT) return counts;
    }
  }
  return counts;
}

/** Any kana means Japanese, then Hangul means Korean, then Han means Chinese. */
function cjkLanguage(c: ScriptCounts): 'ja' | 'ko' | 'zh-Hans' | undefined {
  if (c.kana > 0) return 'ja';
  if (c.hangul > 0) return 'ko';
  if (c.han > 0) return 'zh-Hans';
  return undefined;
}

/**
 * Guesses the language of some text from its script: any kana means Japanese, then Hangul means
 * Korean, then Han characters mean Chinese, then Latin letters mean English. Returns `undefined`
 * when the text holds none of these. Used when a linked table's headers say "sentence" but not
 * which language the sentences are in.
 */
export function guessLanguageFromText(texts: Iterable<string>): string | undefined {
  const counts = countScripts(texts);
  return cjkLanguage(counts) ?? (counts.latin > 0 ? 'en' : undefined);
}

/**
 * Like {@link guessLanguageFromText}, but only for text that is mostly Japanese, Korean or Chinese
 * script: at least as many kana, Hangul and Han characters together as Latin letters. Returns
 * `undefined` for mostly Latin text, or text with no letters, so English glosses beside a few
 * CJK words never count.
 */
export function guessCjkLanguageFromText(
  texts: Iterable<string>,
): 'ja' | 'ko' | 'zh-Hans' | undefined {
  const counts = countScripts(texts);
  const cjk = counts.kana + counts.hangul + counts.han;
  return cjk > 0 && cjk >= counts.latin ? cjkLanguage(counts) : undefined;
}
