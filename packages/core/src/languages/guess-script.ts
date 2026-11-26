/** Characters looked at before guessing; enough for a column of sentences. */
const SAMPLE_LIMIT = 4000;

/**
 * Guesses the language of some text from its script: any kana means Japanese, then Hangul means
 * Korean, then Han characters mean Chinese, then Latin letters mean English. Returns `undefined`
 * when the text holds none of these. Used when a linked table's headers say "sentence" but not
 * which language the sentences are in.
 */
export function guessLanguageFromText(texts: Iterable<string>): string | undefined {
  let kana = 0;
  let hangul = 0;
  let han = 0;
  let latin = 0;
  let seen = 0;
  for (const text of texts) {
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) kana++;
      else if ((cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1100 && cp <= 0x11ff)) hangul++;
      else if (cp >= 0x4e00 && cp <= 0x9fff) han++;
      else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) latin++;
      if (++seen >= SAMPLE_LIMIT) break;
    }
    if (seen >= SAMPLE_LIMIT) break;
  }
  if (kana > 0) return 'ja';
  if (hangul > 0) return 'ko';
  if (han > 0) return 'zh-Hans';
  if (latin > 0) return 'en';
  return undefined;
}
