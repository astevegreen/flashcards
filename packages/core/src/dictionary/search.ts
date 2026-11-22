import {
  analyzeKoreanQuery,
  containsHangul,
  normalizeEnglishEquivalent,
  toChoseong,
  toJamoKey,
  type KoreanQueryAnalysis,
} from './korean.ts';
import type { DictionaryEntry, DictionaryLevel, DictionaryPackId } from './types.ts';

/** Maps Katakana U+30A1..U+30F6 to Hiragana U+3041..U+3096 for kana-insensitive Japanese search. */
export function foldKatakanaToHiragana(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCharCode(code - 0x60);
    } else {
      out += input[i] ?? '';
    }
  }
  return out;
}

/** Strips Latin combining tone marks & diacritics (e.g., `xuéxí` → `xuexi`, `lǚ` → `lv`/`lu`). */
export function stripDiacriticsAndTones(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[1-5]/g, '')
    .replace(/ü/gi, 'u')
    .normalize('NFC');
}

/**
 * Normalizes a raw user search query for dictionary lookup (preserving CJK/Hangul NFC,
 * folding katakana→hiragana, stripping accents/whitespace).
 */
export function normalizeDictionaryQuery(rawQuery: string): {
  raw: string;
  lower: string;
  kanaFolded: string;
  latinStripped: string;
  latinCompact: string;
} {
  const raw = rawQuery.normalize('NFC').trim();
  const lower = raw.toLowerCase();
  const kanaFolded = foldKatakanaToHiragana(lower).replace(/[.・\-\s]+/g, '');
  const latinStripped = stripDiacriticsAndTones(lower).replace(/\s+/g, ' ').trim();
  const latinCompact = latinStripped.replace(/[^a-z0-9]/g, '');
  return { raw, lower, kanaFolded, latinStripped, latinCompact };
}

type AddToken = (tok: string) => void;

/** Adds `text` and, for multi-char CJK compounds, each ideograph (so one kanji/hanzi hits). */
function addWithCjkChars(add: AddToken, text: string): void {
  add(text);
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x3400) add(ch);
  }
}

/** Adds every non-empty piece of `text` split on `separator`. */
function addParts(add: AddToken, text: string, separator: RegExp, minLength: number): void {
  for (const part of text.split(separator)) {
    if (part.length >= minLength) add(part);
  }
}

function addReadingTokens(add: AddToken, reading: string): void {
  const clean = reading.normalize('NFC').trim().toLowerCase();
  if (!clean) return;
  add(clean);
  add(foldKatakanaToHiragana(clean).replace(/[.・-]/g, ''));
  const stripped = stripDiacriticsAndTones(clean);
  add(stripped);
  add(stripped.replace(/[^a-z0-9぀-ヿ가-힯]/g, ''));
  addParts(add, stripped, /[\s/;,()]+/, 1);
}

function addEumhunTokens(add: AddToken, eumhun: string): void {
  const clean = eumhun.normalize('NFC').trim().toLowerCase();
  add(clean);
  addParts(add, clean, /[\s/,;()]+/, 1);
}

function addMeaningTokens(add: AddToken, meaning: string): void {
  const clean = meaning.normalize('NFC').trim().toLowerCase();
  if (!clean) return;
  addParts(add, clean, /[^a-z0-9가-힯぀-ヿ㐀-鿿]+/i, 2);
}

/**
 * Phase 10 Korean word packs: 초성 key (`ㅎㄱ`), jamo prefix key (`ㅎㅏㄴㄱㅜㄱ`), listed
 * conjugations (`먹어`), and the English → Korean reverse index from per-sense equivalents.
 */
function addKoreanWordTokens(
  add: AddToken,
  entry: Pick<DictionaryEntry, 'headword'> & Partial<Pick<DictionaryEntry, 'forms' | 'senses'>>,
): void {
  if (containsHangul(entry.headword)) {
    add(toChoseong(entry.headword));
    add(toJamoKey(entry.headword));
  }
  for (const form of entry.forms ?? []) add(form);
  for (const sense of entry.senses ?? []) {
    for (const eq of sense.equivalents) {
      const key = normalizeEnglishEquivalent(eq);
      if (!key) continue;
      add(key);
      addParts(add, key, /[^a-z0-9]+/, 2);
    }
  }
}

/**
 * Generates compact lowercase search tokens stored in IndexedDB `*searchTokens` multiEntry index.
 * Supports bidirectional native (English) ↔ target language (Hanja/Hangul, Kanji/Kana, Pinyin) search.
 */
export function buildEntrySearchTokens(
  entry: Pick<DictionaryEntry, 'headword' | 'altForms' | 'readings' | 'meanings' | 'eumhun'> &
    Partial<Pick<DictionaryEntry, 'forms' | 'senses'>>,
): string[] {
  const tokens = new Set<string>();
  const add: AddToken = (tok) => {
    const clean = tok.normalize('NFC').trim().toLowerCase();
    if (clean.length > 0 && clean.length <= 64) {
      tokens.add(clean);
    }
  };

  addWithCjkChars(add, entry.headword);
  for (const alt of entry.altForms ?? []) addWithCjkChars(add, alt);
  for (const reading of entry.readings) addReadingTokens(add, reading);
  for (const eh of entry.eumhun ?? []) addEumhunTokens(add, eh);
  for (const meaning of entry.meanings) addMeaningTokens(add, meaning);
  addKoreanWordTokens(add, entry);

  return [...tokens];
}

const LEVEL_BONUS: Readonly<Record<DictionaryLevel | 'none', number>> = {
  beginner: 12,
  intermediate: 8,
  advanced: 4,
  none: 0,
};

/** Normalized English equivalent → headwords, best sense first (Phase 10 reverse index). */
export function buildEnglishReverseIndex(
  entries: readonly Pick<DictionaryEntry, 'headword' | 'senses' | 'level'>[],
): Record<string, string[]> {
  const buckets = new Map<string, Array<{ headword: string; rank: number; order: number }>>();
  entries.forEach((entry, order) => {
    (entry.senses ?? []).forEach((sense, senseIdx) => {
      for (const eq of sense.equivalents) {
        const key = normalizeEnglishEquivalent(eq);
        if (!key) continue;
        let list = buckets.get(key);
        if (!list) {
          list = [];
          buckets.set(key, list);
        }
        const rank = senseIdx * 10 - LEVEL_BONUS[entry.level ?? 'none'];
        const existing = list.find((x) => x.headword === entry.headword);
        if (existing) existing.rank = Math.min(existing.rank, rank);
        else list.push({ headword: entry.headword, rank, order });
      }
    });
  });
  // Null prototype: keys come from pack data, so "__proto__" must stay an ordinary key.
  const out = Object.create(null) as Record<string, string[]>;
  // Code-unit order (not localeCompare) so the index is identical on every machine and locale.
  for (const key of [...buckets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[key] = (buckets.get(key) ?? [])
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map((x) => x.headword);
  }
  return out;
}

export interface DictionarySearchPlan {
  query: ReturnType<typeof normalizeDictionaryQuery>;
  /** Tokens for the `searchTokens` prefix index, most specific first. */
  prefixTokens: string[];
  /** Exact headwords to fetch (deinflected lemmas, romanization candidates), best first. */
  headwordCandidates: string[];
}

const MAX_HEADWORD_CANDIDATES = 400;

/** Code-unit order (not localeCompare) so results are identical on every machine and locale. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Prefix-index tokens for a query, most specific first, without duplicates. */
function planPrefixTokens(q: DictionarySearchPlan['query'], ko: KoreanQueryAnalysis): string[] {
  const tokens = new Set<string>();
  const add = (tok: string | undefined): void => {
    if (tok) tokens.add(tok);
  };

  add(ko.english);
  add(ko.choseong);
  add(q.lower);
  add(q.kanaFolded);
  if (q.latinStripped) {
    add(q.latinStripped);
    for (const word of q.latinStripped.split(/\s+/)) {
      if (word.length >= 2) add(word);
    }
  }
  if (q.latinCompact.length >= 2) add(q.latinCompact);
  if (ko.jamoKey && ko.jamoKey.length >= 2) add(ko.jamoKey);
  for (const p of ko.romanizedJamoPrefixes) add(p);
  return [...tokens];
}

/** Deinflected lemmas and romanization candidates, cheapest first, deduplicated and capped. */
function planHeadwordCandidates(
  q: DictionarySearchPlan['query'],
  ko: KoreanQueryAnalysis,
): string[] {
  const ranked: Array<[string, number]> = [];
  for (const [lemma, steps] of ko.lemmas) {
    if (lemma !== q.raw) ranked.push([lemma, steps]);
  }
  for (const [hangul, cost] of ko.romanized) ranked.push([hangul, cost]);
  ranked.sort((a, b) => a[1] - b[1] || compareCodeUnits(a[0], b[0]));
  const headwordCandidates: string[] = [];
  const seen = new Set<string>();
  for (const [hw] of ranked) {
    if (seen.has(hw)) continue;
    seen.add(hw);
    headwordCandidates.push(hw);
    if (headwordCandidates.length >= MAX_HEADWORD_CANDIDATES) break;
  }
  return headwordCandidates;
}

/**
 * Plans the storage lookups for one query: prefix tokens for the multiEntry index plus exact
 * headword candidates from Korean deinflection / romanization. Fetching those headwords is
 * the validation step — candidates the pack does not contain simply return nothing.
 */
export function planDictionarySearch(rawQuery: string): DictionarySearchPlan {
  const q = normalizeDictionaryQuery(rawQuery);
  const ko = analyzeKoreanQuery(q.raw);
  return {
    query: q,
    prefixTokens: planPrefixTokens(q, ko),
    headwordCandidates: planHeadwordCandidates(q, ko),
  };
}

/**
 * Ceiling for a romanization match when the query is also an English word some candidate
 * translates exactly: below the English-equivalent (780–800) and exact-meaning (760) tiers,
 * so `son` ranks 아들 above 손 and `go` ranks 가다 above 고.
 */
const ROMANIZATION_CAP_WHEN_ENGLISH_HIT = 750;

/** True when a meaning (or one of its `;`/`,`-separated parts) is exactly the query. */
function hasExactMeaning(entry: DictionaryEntry, lower: string): boolean {
  return entry.meanings.some((m) => {
    const ml = m.toLowerCase();
    return ml === lower || ml.split(/[;,/()]+/).some((part) => part.trim() === lower);
  });
}

function hasExactEnglishMatch(entry: DictionaryEntry, english: string, lower: string): boolean {
  if (
    entry.senses?.some((s) =>
      s.equivalents.some((eq) => normalizeEnglishEquivalent(eq) === english),
    )
  ) {
    return true;
  }
  return hasExactMeaning(entry, lower);
}

/** Deinflected-lemma (`먹었어요` → 먹다) and listed-conjugation matches. */
function deinflectionScore(
  entry: DictionaryEntry,
  ko: KoreanQueryAnalysis,
  rawQuery: string,
): number {
  const steps = ko.lemmas.get(entry.headword);
  const lemmaScore = steps !== undefined && steps > 0 ? 950 - steps * 5 : 0;
  const formScore = rawQuery && entry.forms?.includes(rawQuery) ? 945 : 0;
  return Math.max(lemmaScore, formScore);
}

function romanizationScore(hw: string, ko: KoreanQueryAnalysis, romanizationCap: number): number {
  const romCost = ko.romanized.get(hw);
  if (romCost === undefined) return 0;
  return Math.min(romanizationCap, Math.max(700, 900 - romCost * 10));
}

/** English → Korean reverse-index match, higher for earlier senses. */
function englishEquivalentScore(entry: DictionaryEntry, ko: KoreanQueryAnalysis): number {
  const english = ko.english;
  if (!english || !entry.senses) return 0;
  const idx = entry.senses.findIndex((s) =>
    s.equivalents.some((eq) => normalizeEnglishEquivalent(eq) === english),
  );
  return idx >= 0 ? 800 - Math.min(idx, 5) * 4 : 0;
}

function choseongScore(hw: string, choseong: string): number {
  const ch = toChoseong(hw);
  if (ch === choseong) return 870;
  return ch.startsWith(choseong) ? 690 : 0;
}

/** 초성 and jamo-prefix matches (typed mid-IME, or romanized while typing). */
function hangulKeyScore(hw: string, ko: KoreanQueryAnalysis): number {
  const wantsKeys = Boolean(ko.choseong || ko.jamoKey || ko.romanizedJamoPrefixes.length > 0);
  if (!wantsKeys || !containsHangul(hw)) return 0;
  let best = ko.choseong ? choseongScore(hw, ko.choseong) : 0;
  const jk = toJamoKey(hw);
  if (ko.jamoKey && jk !== ko.jamoKey && jk.startsWith(ko.jamoKey)) best = Math.max(best, 600);
  if (ko.romanizedJamoPrefixes.some((p) => p.length > 0 && jk.startsWith(p))) {
    best = Math.max(best, 560);
  }
  return best;
}

/** Korean-specific match score for one entry (0 = no Korean-specific match). */
function koreanMatchScore(
  entry: DictionaryEntry,
  ko: KoreanQueryAnalysis,
  rawQuery: string,
  romanizationCap: number,
): number {
  return Math.max(
    0,
    deinflectionScore(entry, ko, rawQuery),
    romanizationScore(entry.headword, ko, romanizationCap),
    englishEquivalentScore(entry, ko),
    hangulKeyScore(entry.headword, ko),
  );
}

export interface RankDictionaryOptions {
  packIds?: readonly DictionaryPackId[];
  limit?: number;
}

type NormalizedQuery = ReturnType<typeof normalizeDictionaryQuery>;

function readingMatchesExactly(entry: DictionaryEntry, q: NormalizedQuery): boolean {
  return entry.readings.some((r) => {
    const rl = r.normalize('NFC').toLowerCase();
    const rKana = foldKatakanaToHiragana(rl).replace(/[.・\-\s]+/g, '');
    const rCompact = stripDiacriticsAndTones(rl).replace(/[^a-z0-9]/g, '');
    return (
      rl === q.lower ||
      (q.kanaFolded.length > 0 && rKana === q.kanaFolded) ||
      (q.latinCompact.length > 0 && rCompact === q.latinCompact)
    );
  });
}

function readingStartsWith(entry: DictionaryEntry, q: NormalizedQuery): boolean {
  return entry.readings.some((r) => {
    const rKana = foldKatakanaToHiragana(r.toLowerCase()).replace(/[.・\-\s]+/g, '');
    const rCompact = stripDiacriticsAndTones(r.toLowerCase()).replace(/[^a-z0-9]/g, '');
    return (
      (q.kanaFolded.length > 0 && rKana.startsWith(q.kanaFolded)) ||
      (q.latinCompact.length > 0 && rCompact.startsWith(q.latinCompact))
    );
  });
}

function meaningHasWord(entry: DictionaryEntry, word: string): boolean {
  return entry.meanings.some((m) =>
    m
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((w) => w === word),
  );
}

function hasSubstringMatch(entry: DictionaryEntry, hwLower: string, q: NormalizedQuery): boolean {
  return (
    hwLower.includes(q.lower) ||
    entry.meanings.some((m) => m.toLowerCase().includes(q.lower)) ||
    entry.searchTokens.some(
      (t) =>
        t.startsWith(q.lower) ||
        (q.kanaFolded.length > 0 && t.startsWith(q.kanaFolded)) ||
        (q.latinCompact.length > 0 && t.startsWith(q.latinCompact)),
    )
  );
}

/** Language-neutral match tier for one entry (0 = no match). */
function baseMatchScore(entry: DictionaryEntry, q: NormalizedQuery): number {
  if (!q.lower) return 10;
  const hwLower = entry.headword.normalize('NFC').toLowerCase();
  if (hwLower === q.lower) return 1000;
  if (entry.altForms?.some((a) => a.normalize('NFC').toLowerCase() === q.lower)) return 920;
  if (readingMatchesExactly(entry, q)) return 840;
  if (entry.eumhun?.some((eh) => eh.normalize('NFC').toLowerCase().includes(q.lower))) return 780;
  if (hasExactMeaning(entry, q.lower)) return 760;
  if (hwLower.startsWith(q.lower) || readingStartsWith(entry, q)) return 680;
  if (meaningHasWord(entry, q.latinStripped)) return 640;
  if (hasSubstringMatch(entry, hwLower, q)) return 500;
  return 0;
}

/** Gentle tie-breakers: shorter headwords, Hanja education grade, frequency rank, learner level. */
function applyTieBreakers(score: number, entry: DictionaryEntry): number {
  let out = score;
  if (entry.grade?.toLowerCase().includes('education')) {
    out += 15;
  }
  if (entry.level) {
    out += LEVEL_BONUS[entry.level];
  }
  if (entry.frequency !== undefined && entry.frequency > 0) {
    out += Math.max(0, 20 - Math.log10(entry.frequency) * 4);
  }
  out -= Math.min(10, entry.headword.length * 0.5);
  return out;
}

/**
 * An English query that also parses as romanization (`son` → 손, `man` → 만) must not outrank
 * the real translation, so romanization is capped whenever some candidate translates it.
 */
function romanizationCapFor(
  candidates: readonly DictionaryEntry[],
  ko: KoreanQueryAnalysis,
  lower: string,
  allowedPacks: ReadonlySet<DictionaryPackId> | null,
): number {
  const english = ko.english;
  if (english === undefined || ko.romanized.size === 0) return Number.POSITIVE_INFINITY;
  const translated = candidates.some(
    (e) => (!allowedPacks || allowedPacks.has(e.packId)) && hasExactEnglishMatch(e, english, lower),
  );
  return translated ? ROMANIZATION_CAP_WHEN_ENGLISH_HIT : Number.POSITIVE_INFINITY;
}

/**
 * Deterministically ranks candidate dictionary entries against a user query.
 * Priority: exact headword > exact altForm > exact reading > reading prefix >
 * exact English meaning word > substring match, broken by frequency / education Hanja.
 */
export function rankDictionaryResults(
  candidates: readonly DictionaryEntry[],
  rawQuery: string,
  opts: RankDictionaryOptions = {},
): DictionaryEntry[] {
  const q = normalizeDictionaryQuery(rawQuery);
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const allowedPacks = opts.packIds && opts.packIds.length > 0 ? new Set(opts.packIds) : null;
  const ko = analyzeKoreanQuery(q.raw);
  const romanizationCap = romanizationCapFor(candidates, ko, q.lower, allowedPacks);

  const scored: Array<{ entry: DictionaryEntry; score: number }> = [];

  for (const entry of candidates) {
    if (allowedPacks && !allowedPacks.has(entry.packId)) continue;

    let score = baseMatchScore(entry, q);
    // Korean-specific matches (deinflection, romanization, 초성, jamo prefix, English equivalents)
    if (q.lower && score < 1000) {
      score = Math.max(score, koreanMatchScore(entry, ko, q.raw, romanizationCap));
    }
    if (score <= 0) continue;

    scored.push({ entry, score: applyTieBreakers(score, entry) });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.headword.length - b.entry.headword.length ||
      (a.entry.id < b.entry.id ? -1 : 1),
  );

  return scored.slice(0, limit).map((s) => s.entry);
}
