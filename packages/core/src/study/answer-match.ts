/**
 * Typed-answer matching & character-level diff engine per blueprint §5.2.
 * Exported strictly via lazy subpath `@flash/core/answer-match` so `wanakana` adds 0 KB
 * to the initial study-screen JS bundle (§8).
 */

import { toHiragana, toKana } from 'wanakana';
import { stripCloze } from '../parsers/cloze.ts';
import { formatPinyin } from '../parsers/pinyin.ts';
import { stripRuby } from '../parsers/ruby.ts';

export interface AnswerMatchOptions {
  lang: string;
  /** Japanese: treat hiragana and katakana as equivalent (default true). */
  jaKanaEquivalent?: boolean;
  /** Mandarin: ignore pinyin tone marks/numbers (default false). */
  zhIgnoreTones?: boolean;
}

export type DiffOpType = 'equal' | 'insert' | 'delete';

export interface DiffOp {
  op: DiffOpType;
  text: string;
}

export interface AnswerMatchResult {
  correct: boolean;
  /** 3 = Good, 1 = Again (always overridable by user). */
  suggestedRating: 3 | 1;
  normalizedInput: string;
  normalizedExpected: string;
  matchedCandidate: string;
  candidates: string[];
  diff: DiffOp[];
}

const MAX_OPTIONAL_COMBINATIONS = 16;
const MAX_TOTAL_CANDIDATES = 64;

/**
 * Splits alternate answers on `;` or `|` outside parentheses `(...)` / `（...）`.
 */
function splitAlternates(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let parenDepth = 0;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(' || ch === '（') {
      parenDepth += 1;
      current += ch;
    } else if ((ch === ')' || ch === '）') && parenDepth > 0) {
      parenDepth -= 1;
      current += ch;
    } else if (parenDepth === 0 && (ch === ';' || ch === '|')) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }

  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * Expands optional `(…)` / `（…）` segments into up to `MAX_OPTIONAL_COMBINATIONS` variants.
 */
function expandOptionalSegments(raw: string): string[] {
  const groups: Array<{ start: number; end: number; inner: string }> = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(' || ch === '（') {
      if (depth === 0) start = i;
      depth += 1;
    } else if ((ch === ')' || ch === '）') && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        groups.push({ start, end: i + 1, inner: raw.slice(start + 1, i) });
        start = -1;
      }
    }
  }

  if (groups.length === 0) {
    return [raw.trim()].filter((s) => s.length > 0);
  }

  // Cap expanded groups to 4 (2^4 = 16 combinations) to avoid exponential blowup
  const expandable = groups.slice(0, 4);
  const results: string[] = [];
  const seen = new Set<string>();

  const totalMasks = Math.min(1 << expandable.length, MAX_OPTIONAL_COMBINATIONS);
  for (let mask = 0; mask < totalMasks; mask++) {
    let built = '';
    let cursor = 0;
    for (let gIdx = 0; gIdx < expandable.length; gIdx++) {
      const g = expandable[gIdx];
      if (!g) continue;
      built += raw.slice(cursor, g.start);
      if ((mask & (1 << gIdx)) !== 0) {
        built += g.inner;
      }
      cursor = g.end;
    }
    built += raw.slice(cursor);
    const cleaned = built.replace(/\s+/g, ' ').trim();
    if (cleaned.length > 0 && !seen.has(cleaned)) {
      seen.add(cleaned);
      results.push(cleaned);
    }
  }

  return results;
}

function isJapaneseLang(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === 'ja' || l.startsWith('ja-');
}

function isChineseLang(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === 'zh' || l.startsWith('zh-');
}

function isKoreanLang(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === 'ko' || l.startsWith('ko-');
}

function stripPinyinTones(text: string): string {
  // Decompose NFD so tone combining marks (macron, acute, caron, grave) separate cleanly
  // while preserving diaeresis (\u0308) on `ü`.
  return text
    .normalize('NFD')
    .replace(/[\u0304\u0301\u030c\u0300]/g, '')
    .normalize('NFC');
}

/**
 * Normalizes a string according to universal and language-specific rules (§5.2).
 */
export function normalizeForMatching(raw: string, options: AnswerMatchOptions): string {
  let text = raw.normalize('NFKC').trim();
  if (!text) return '';

  const { lang, jaKanaEquivalent = true, zhIgnoreTones = false } = options;

  if (isChineseLang(lang)) {
    // Convert numbered pinyin (`ni3`, `lv4`, `nu:3`) BEFORE stripping punctuation so `u:` is handled
    text = formatPinyin(text);
    text = text.toLowerCase();
    if (zhIgnoreTones) {
      text = stripPinyinTones(text);
    }
  } else if (isJapaneseLang(lang)) {
    if (jaKanaEquivalent) {
      // Preserve `ー` (U+30FC) so katakana loanwords (`ラーメン`/`コーヒー`) match both `らーめん`/`こーひー` and `ra-men`/`ko-hi-`
      text = toHiragana(text, { passRomaji: false, convertLongVowelMark: false });
    } else {
      text = toKana(text);
    }
    text = text.toLowerCase();
  } else {
    text = text.toLowerCase();
  }

  // Strip apostrophes without inserting spaces (`don't` === `dont`, `xī'ān` === `xīān`)
  text = text.replace(/['’ʼ]/g, '');
  // Strip Unicode punctuation and symbols while preserving letters, numbers, combining marks, and `ー` (U+30FC, \p{Lm})
  text = text.replace(/[\p{P}\p{S}]+/gu, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  if (isKoreanLang(lang) || isChineseLang(lang)) {
    text = text.normalize('NFC');
  }

  return text;
}

/**
 * Live romaji -> kana converter for Japanese typed-answer input (`IMEMode: true` keeps trailing `n` pending).
 */
export function convertJaRomajiLive(value: string): string {
  if (!value) return value;
  return toKana(value, { IMEMode: true });
}

/**
 * Computes a Unicode code-point LCS character diff transforming `expected` -> `actual`.
 * - `equal`: character present in both
 * - `delete`: character missing from user's input (present in expected)
 * - `insert`: extra/wrong character typed by user (present in actual)
 */
export function computeCharDiff(expected: string, actual: string): DiffOp[] {
  const a = Array.from(expected);
  const b = Array.from(actual);
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ op: 'insert', text: actual }];
  if (m === 0) return [{ op: 'delete', text: expected }];

  // Guard against extreme lengths (> 400 code points) to stay O(1) ms on main thread
  if (n * m > 160_000) {
    return expected === actual
      ? [{ op: 'equal', text: expected }]
      : [
          { op: 'delete', text: expected },
          { op: 'insert', text: actual },
        ];
  }

  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    if (!row || !nextRow) continue;
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        row[j] = (nextRow[j + 1] ?? 0) + 1;
      } else {
        const down = nextRow[j] ?? 0;
        const right = row[j + 1] ?? 0;
        row[j] = down >= right ? down : right;
      }
    }
  }

  const ops: DiffOp[] = [];
  const pushOp = (op: DiffOpType, ch: string): void => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) {
      last.text += ch;
    } else {
      ops.push({ op, text: ch });
    }
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] ?? '';
    const bj = b[j] ?? '';
    if (ai === bj) {
      pushOp('equal', ai);
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      pushOp('delete', ai);
      i += 1;
    } else {
      pushOp('insert', bj);
      j += 1;
    }
  }
  while (i < n) {
    pushOp('delete', a[i] ?? '');
    i += 1;
  }
  while (j < m) {
    pushOp('insert', b[j] ?? '');
    j += 1;
  }

  return ops;
}

function diffEditCost(ops: readonly DiffOp[]): number {
  let cost = 0;
  for (const op of ops) {
    if (op.op !== 'equal') {
      cost += Array.from(op.text).length;
    }
  }
  return cost;
}

/**
 * Expands `expectedRaw` (stripping ruby/cloze, splitting `;`/`|`, expanding `(...)`) into displayable candidates.
 */
export function expandAnswerCandidates(expectedRaw: string): string[] {
  const cleaned = stripRuby(stripCloze(expectedRaw)).trim();
  if (!cleaned) return [];
  const alternates = splitAlternates(cleaned);
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const alt of alternates) {
    for (const expanded of expandOptionalSegments(alt)) {
      if (!seen.has(expanded)) {
        seen.add(expanded);
        candidates.push(expanded);
        if (candidates.length >= MAX_TOTAL_CANDIDATES) {
          return candidates;
        }
      }
    }
  }

  return candidates;
}

/**
 * Evaluates a user's typed answer against `expectedRaw` per blueprint §5.2.
 */
export function matchTypedAnswer(
  input: string,
  expectedRaw: string,
  options: AnswerMatchOptions,
): AnswerMatchResult {
  const candidates = expandAnswerCandidates(expectedRaw);
  const normalizedInput = normalizeForMatching(input, options);

  if (candidates.length === 0) {
    const fallbackExpected = normalizeForMatching(expectedRaw, options);
    const correct = normalizedInput === fallbackExpected && fallbackExpected.length > 0;
    return {
      correct,
      suggestedRating: correct ? 3 : 1,
      normalizedInput,
      normalizedExpected: fallbackExpected,
      matchedCandidate: expectedRaw.trim(),
      candidates: expectedRaw.trim() ? [expectedRaw.trim()] : [],
      diff: computeCharDiff(fallbackExpected, normalizedInput),
    };
  }

  const isZhPinyin = isChineseLang(options.lang);
  const compactInput = isZhPinyin ? normalizedInput.replace(/\s+/g, '') : normalizedInput;

  let bestCandidate = candidates[0] ?? '';
  let bestNormalized = normalizeForMatching(bestCandidate, options);
  let bestDiff = computeCharDiff(bestNormalized, normalizedInput);
  let bestCost = diffEditCost(bestDiff);

  for (const cand of candidates) {
    const normCand = normalizeForMatching(cand, options);
    if (normCand.length === 0) continue;

    const exactMatch = normalizedInput === normCand;
    const pinyinSpaceMatch =
      !exactMatch &&
      isZhPinyin &&
      /^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ\s]+$/i.test(normCand) &&
      compactInput === normCand.replace(/\s+/g, '');

    if (exactMatch || pinyinSpaceMatch) {
      return {
        correct: true,
        suggestedRating: 3,
        normalizedInput,
        normalizedExpected: normCand,
        matchedCandidate: cand,
        candidates,
        diff: [{ op: 'equal', text: normCand }],
      };
    }

    const diff = computeCharDiff(normCand, normalizedInput);
    const cost = diffEditCost(diff);
    if (cost < bestCost) {
      bestCost = cost;
      bestCandidate = cand;
      bestNormalized = normCand;
      bestDiff = diff;
    }
  }

  return {
    correct: false,
    suggestedRating: 1,
    normalizedInput,
    normalizedExpected: bestNormalized,
    matchedCandidate: bestCandidate,
    candidates,
    diff: bestDiff,
  };
}
