/**
 * Mandarin Pinyin parser & tone-mark converter per blueprint §6.2.
 * Converts tone numbers (e.g. `ni3 hao3`, `lv4`, `nu:3`, `ma5`) into tone-marked
 * syllables (`nǐ hǎo`, `lǜ`, `nǚ`, `ma`) with tone metadata (1-5) for optional tone coloring.
 */

export type PinyinTone = 0 | 1 | 2 | 3 | 4 | 5;

export interface PinyinToken {
  text: string;
  tone: PinyinTone;
}

const TONE_MAP: Record<string, readonly [string, string, string, string, string]> = {
  a: ['ā', 'á', 'ǎ', 'à', 'a'],
  e: ['ē', 'é', 'ě', 'è', 'e'],
  i: ['ī', 'í', 'ǐ', 'ì', 'i'],
  o: ['ō', 'ó', 'ǒ', 'ò', 'o'],
  u: ['ū', 'ú', 'ǔ', 'ù', 'u'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ', 'ü'],
  A: ['Ā', 'Á', 'Ǎ', 'À', 'A'],
  E: ['Ē', 'É', 'Ě', 'È', 'E'],
  I: ['Ī', 'Í', 'Ǐ', 'Ì', 'I'],
  O: ['Ō', 'Ó', 'Ǒ', 'Ò', 'O'],
  U: ['Ū', 'Ú', 'Ǔ', 'Ù', 'U'],
  Ü: ['Ǖ', 'Ǘ', 'Ǚ', 'Ǜ', 'Ü'],
};

const MARKED_VOWEL_TONE = new Map<string, PinyinTone>();
for (const forms of Object.values(TONE_MAP)) {
  MARKED_VOWEL_TONE.set(forms[0], 1);
  MARKED_VOWEL_TONE.set(forms[1], 2);
  MARKED_VOWEL_TONE.set(forms[2], 3);
  MARKED_VOWEL_TONE.set(forms[3], 4);
}

function normalizeUmlaut(syllable: string, isNumbered: boolean): string {
  // Always convert explicit u:/U: to ü/Ü.
  // Convert v/V to ü/Ü only in valid Hanyu Pinyin umlaut positions (after l/n, or standalone v/ve with tone digit)
  // so non-pinyin text like "vs." or "very" is never corrupted.
  let out = syllable.replace(/u:/g, 'ü').replace(/U:/g, 'Ü');
  out = out.replace(/([lLnN])v/g, '$1ü').replace(/([lLnN])V/g, '$1Ü');
  if (isNumbered && /^[vV][eE]?$/.test(out)) {
    out = out.replace(/v/g, 'ü').replace(/V/g, 'Ü');
  }
  return out;
}

/**
 * The shape of a Hanyu Pinyin syllable: an optional initial, vowels, then an optional `n`/`ng`
 * and erhua `r`. A word followed by a digit that has another shape (`Windows1`) keeps its digit.
 */
const PINYIN_SYLLABLE = /^([b-df-hj-np-tw-z]|[csz]h)?[aeiouvüê]+(ng?)?r?$/;

/**
 * Standard Hanyu Pinyin tone placement rule:
 * 1. If `a` or `e` is present, it takes the tone mark.
 * 2. If `ou` is present, `o` takes the tone mark.
 * 3. Otherwise, the last vowel (`a, e, i, o, u, ü`) takes the tone mark.
 * Returns `null` if it is not a syllable (e.g., "hsk3", "Windows1"), so callers keep it verbatim.
 */
function applyToneMark(rawSyllable: string, tone: 1 | 2 | 3 | 4 | 5): string | null {
  const normalized = normalizeUmlaut(rawSyllable, true);
  const lower = normalized.toLowerCase();
  if (!PINYIN_SYLLABLE.test(lower)) return null;
  let targetIndex = -1;

  const aIdx = lower.indexOf('a');
  const eIdx = lower.indexOf('e');
  const ouIdx = lower.indexOf('ou');

  if (aIdx !== -1) {
    targetIndex = aIdx;
  } else if (eIdx !== -1) {
    targetIndex = eIdx;
  } else if (ouIdx !== -1) {
    targetIndex = ouIdx;
  } else {
    for (let i = lower.length - 1; i >= 0; i--) {
      const c = lower[i];
      if (c === 'i' || c === 'o' || c === 'u' || c === 'ü') {
        targetIndex = i;
        break;
      }
    }
  }

  if (targetIndex === -1) return null;
  if (tone === 5) return normalized;

  const ch = normalized[targetIndex];
  if (ch === undefined) return normalized;
  const forms = TONE_MAP[ch];
  if (!forms) return normalized;

  const marked = forms[tone - 1] ?? ch;
  return normalized.slice(0, targetIndex) + marked + normalized.slice(targetIndex + 1);
}

function detectToneFromMarkedSyllable(word: string): PinyinTone {
  for (const ch of word) {
    const t = MARKED_VOWEL_TONE.get(ch);
    if (t !== undefined) return t;
  }
  return /[a-zA-ZüÜ]/.test(word) ? 5 : 0;
}

/**
 * Tokenizes a pinyin string into syllable & separator tokens with tone numbers (1-5, or 0 for non-syllables).
 * Supports both numbered pinyin (`ni3 hao3`, `Zhong1guo2`, `lv4`, `nu:3`) and already tone-marked pinyin (`nǐ hǎo`).
 */
export function parsePinyin(input: string): PinyinToken[] {
  if (!input) return [];

  const tokens: PinyinToken[] = [];
  // Matches either:
  // 1) A Latin/ü/u: syllable followed by tone digit 0-5 (e.g. `ni3`, `nu:3`, `u:3`, `lv4`, `Zhong1`, `ma5`)
  // 2) An already tone-marked or plain alphabetic word (including `u:` umlaut form like `lu:e`)
  // 3) Any non-word separator/punctuation run
  const tokenRegex =
    /((?:u:|U:|[a-zA-ZüÜ])+?)([0-5])|((?:u:|U:|[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ])+)|([^a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ]+)/g;

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(input)) !== null) {
    const [, numberedBase, toneDigit, plainWord, other] = match;
    if (numberedBase !== undefined && toneDigit !== undefined) {
      const digit = Number(toneDigit);
      const tone = (digit === 0 ? 5 : digit) as 1 | 2 | 3 | 4 | 5;
      const marked = applyToneMark(numberedBase, tone);
      if (marked === null) {
        tokens.push({
          text: numberedBase + toneDigit,
          tone: 0,
        });
      } else {
        tokens.push({
          text: marked,
          tone,
        });
      }
    } else if (plainWord !== undefined) {
      const normalized = normalizeUmlaut(plainWord, false);
      tokens.push({
        text: normalized,
        tone: detectToneFromMarkedSyllable(normalized),
      });
    } else if (other !== undefined) {
      tokens.push({
        text: other,
        tone: 0,
      });
    }
  }

  return tokens;
}

/** Formats numbered pinyin into tone-marked pinyin text. */
export function formatPinyin(input: string): string {
  return parsePinyin(input)
    .map((t) => t.text)
    .join('');
}
