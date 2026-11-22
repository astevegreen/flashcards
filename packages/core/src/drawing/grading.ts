import type { CollectionPreferences, DrawingMode, ReviewRating } from '../model/types.ts';
import { stripCloze } from '../parsers/cloze.ts';
import { stripRuby } from '../parsers/ruby.ts';
import type { StrokeScript } from './types.ts';

/**
 * Normalizes a BCP-47 language tag to the drawing preference bucket (`ja`, `zh-Hans`, `ko`, or base tag).
 */
export function normalizeDrawingLang(rawLang: string | undefined): string {
  const clean = (rawLang ?? '').trim().toLowerCase();
  if (!clean) return 'en';
  if (clean === 'ja' || clean.startsWith('ja-')) return 'ja';
  if (
    clean === 'zh' ||
    clean === 'zh-hans' ||
    clean.startsWith('zh-hans-') ||
    clean === 'zh-cn' ||
    clean === 'zh-sg'
  ) {
    return 'zh-Hans';
  }
  if (
    clean === 'zh-hant' ||
    clean.startsWith('zh-hant-') ||
    clean === 'zh-tw' ||
    clean === 'zh-hk'
  ) {
    return 'zh-Hant';
  }
  if (clean === 'ko' || clean.startsWith('ko-')) return 'ko';
  return clean.split('-')[0] ?? clean;
}

/**
 * Resolves the effective drawing mode for a language (§6.4):
 * Defaults: `ja -> graded`, `zh-Hans -> graded`, `ko -> lookup` (Hanja default), others -> `off`.
 */
export function resolveDrawingMode(
  prefs: Pick<CollectionPreferences, 'drawing_modes'> | undefined,
  lang: string | undefined,
): DrawingMode {
  const norm = normalizeDrawingLang(lang);
  const explicit = prefs?.drawing_modes?.[norm];
  if (explicit === 'graded' || explicit === 'lookup' || explicit === 'off') {
    return explicit;
  }
  if (norm === 'ja' || norm === 'zh-Hans') return 'graded';
  if (norm === 'ko') return 'lookup';
  return 'off';
}

/** Maps language tag to the separate stroke-data script (`ja` KanjiVG vs `zh-Hans` Make Me a Hanzi). */
export function resolveStrokeScriptForLang(lang: string | undefined): StrokeScript {
  const norm = normalizeDrawingLang(lang);
  return norm === 'ja' ? 'ja' : 'zh-Hans';
}

/**
 * Maps graded drawing quiz mistake count to suggested FSRS rating (§6.4):
 * - `0` mistakes → Easy (`4`)
 * - `1–2` mistakes → Good (`3`)
 * - `3+` mistakes → Again (`1`)
 */
export function mapDrawMistakesToRating(totalMistakes: number): ReviewRating {
  if (!Number.isFinite(totalMistakes) || totalMistakes <= 0) return 4;
  if (totalMistakes <= 2) return 3;
  return 1;
}

function isHanCharacter(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0x20000 && cp <= 0x2a6df) || // CJK Extension B
    (cp >= 0x2a700 && cp <= 0x2ebef) || // CJK Extensions C-F
    (cp >= 0x30000 && cp <= 0x323af) // CJK Extensions G-H
  );
}

function isKanaCharacter(cp: number): boolean {
  return (cp >= 0x3041 && cp <= 0x3096) || (cp >= 0x30a1 && cp <= 0x30fa);
}

/**
 * Extracts ordered drawable characters from a card field value.
 * - Strips inline ruby (`日本[にほん]`, `{今日|きょう}`) and cloze (`{{c1::...}}`) syntax first.
 * - For `zh-Hans` / `ko` (Hanja), extracts Han ideographs only.
 * - For `ja`, extracts Han ideographs (and falls back to kana if the word has no kanji, or includes kana when `includeJaKana` is true).
 */
export function extractDrawableCharacters(
  rawText: string,
  lang: string = 'ja',
  opts?: { includeJaKana?: boolean },
): string[] {
  const plain = stripRuby(stripCloze(rawText)).trim();
  if (!plain) return [];

  const normLang = normalizeDrawingLang(lang);
  const hanChars: string[] = [];
  const jaAllChars: string[] = [];

  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isHanCharacter(cp)) {
      hanChars.push(ch);
      jaAllChars.push(ch);
    } else if (normLang === 'ja' && isKanaCharacter(cp)) {
      jaAllChars.push(ch);
    }
  }

  if (normLang === 'ja') {
    if (opts?.includeJaKana) return jaAllChars;
    return hanChars.length > 0 ? hanChars : jaAllChars;
  }

  return hanChars;
}
