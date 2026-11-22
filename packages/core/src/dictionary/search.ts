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

/**
 * Generates compact lowercase search tokens stored in IndexedDB `*searchTokens` multiEntry index.
 * Supports bidirectional native (English) ↔ target language (Hanja/Hangul, Kanji/Kana, Pinyin) search.
 */
export function buildEntrySearchTokens(
  entry: Pick<DictionaryEntry, 'headword' | 'altForms' | 'readings' | 'meanings' | 'eumhun'> &
    Partial<Pick<DictionaryEntry, 'forms' | 'senses'>>,
): string[] {
  const tokens = new Set<string>();
  const add = (tok: string): void => {
    const clean = tok.normalize('NFC').trim().toLowerCase();
    if (clean.length > 0 && clean.length <= 64) {
      tokens.add(clean);
    }
  };

  add(entry.headword);
  // Also index individual CJK characters for multi-char compounds (so searching a single kanji/hanzi hits)
  for (const ch of entry.headword) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x3400) add(ch);
  }

  for (const alt of entry.altForms ?? []) {
    add(alt);
    for (const ch of alt) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp >= 0x3400) add(ch);
    }
  }

  for (const reading of entry.readings) {
    const clean = reading.normalize('NFC').trim().toLowerCase();
    if (!clean) continue;
    add(clean);
    const kana = foldKatakanaToHiragana(clean).replace(/[.・-]/g, '');
    add(kana);
    const stripped = stripDiacriticsAndTones(clean);
    add(stripped);
    const compact = stripped.replace(/[^a-z0-9\u3040-\u30ff\uac00-\ud7af]/g, '');
    add(compact);
    for (const part of stripped.split(/[\s/;,()]+/)) {
      if (part.length >= 1) add(part);
    }
  }

  for (const eh of entry.eumhun ?? []) {
    const clean = eh.normalize('NFC').trim().toLowerCase();
    add(clean);
    for (const part of clean.split(/[\s/,;()]+/)) {
      if (part.length >= 1) add(part);
    }
  }

  for (const meaning of entry.meanings) {
    const clean = meaning.normalize('NFC').trim().toLowerCase();
    if (!clean) continue;
    const words = clean.split(/[^a-z0-9\uac00-\ud7af\u3040-\u30ff\u3400-\u9fff]+/i);
    for (const w of words) {
      if (w.length >= 2) {
        add(w);
      }
    }
  }

  // Phase 10 Korean word packs: 초성 key (`ㅎㄱ`), jamo prefix key (`ㅎㅏㄴㄱㅜㄱ`), listed
  // conjugations (`먹어`), and the English → Korean reverse index from per-sense equivalents.
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
      for (const w of key.split(/[^a-z0-9]+/)) {
        if (w.length >= 2) add(w);
      }
    }
  }

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
  for (const key of [...buckets.keys()].sort()) {
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

/**
 * Plans the storage lookups for one query: prefix tokens for the multiEntry index plus exact
 * headword candidates from Korean deinflection / romanization. Fetching those headwords is
 * the validation step — candidates the pack does not contain simply return nothing.
 */
export function planDictionarySearch(rawQuery: string): DictionarySearchPlan {
  const q = normalizeDictionaryQuery(rawQuery);
  const ko = analyzeKoreanQuery(q.raw);
  const prefixTokens: string[] = [];
  const seen = new Set<string>();
  const add = (tok: string | undefined): void => {
    if (tok && !seen.has(tok)) {
      seen.add(tok);
      prefixTokens.push(tok);
    }
  };

  if (ko.english) add(ko.english);
  if (ko.choseong) add(ko.choseong);
  add(q.lower);
  if (q.kanaFolded) add(q.kanaFolded);
  if (q.latinStripped) {
    add(q.latinStripped);
    for (const word of q.latinStripped.split(/\s+/)) {
      if (word.length >= 2) add(word);
    }
  }
  if (q.latinCompact && q.latinCompact.length >= 2) add(q.latinCompact);
  if (ko.jamoKey && ko.jamoKey.length >= 2) add(ko.jamoKey);
  for (const p of ko.romanizedJamoPrefixes) add(p);

  const ranked: Array<[string, number]> = [];
  for (const [lemma, steps] of ko.lemmas) {
    if (lemma !== q.raw) ranked.push([lemma, steps]);
  }
  for (const [hangul, cost] of ko.romanized) ranked.push([hangul, cost]);
  ranked.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const headwordCandidates: string[] = [];
  const seenHw = new Set<string>();
  for (const [hw] of ranked) {
    if (seenHw.has(hw)) continue;
    seenHw.add(hw);
    headwordCandidates.push(hw);
    if (headwordCandidates.length >= MAX_HEADWORD_CANDIDATES) break;
  }

  return { query: q, prefixTokens, headwordCandidates };
}

/** Korean-specific match score for one entry (0 = no Korean-specific match). */
function koreanMatchScore(
  entry: DictionaryEntry,
  ko: KoreanQueryAnalysis,
  rawQuery: string,
): number {
  let best = 0;
  const hw = entry.headword;

  const steps = ko.lemmas.get(hw);
  if (steps !== undefined && steps > 0) best = Math.max(best, 950 - steps * 5);
  if (rawQuery && entry.forms?.includes(rawQuery)) best = Math.max(best, 945);

  const romCost = ko.romanized.get(hw);
  if (romCost !== undefined) best = Math.max(best, Math.max(700, 900 - romCost * 10));

  if (ko.english && entry.senses) {
    const english = ko.english;
    const idx = entry.senses.findIndex((s) =>
      s.equivalents.some((eq) => normalizeEnglishEquivalent(eq) === english),
    );
    if (idx >= 0) best = Math.max(best, 800 - Math.min(idx, 5) * 4);
  }

  if ((ko.choseong || ko.jamoKey || ko.romanizedJamoPrefixes.length > 0) && containsHangul(hw)) {
    if (ko.choseong) {
      const ch = toChoseong(hw);
      if (ch === ko.choseong) best = Math.max(best, 870);
      else if (ch.startsWith(ko.choseong)) best = Math.max(best, 690);
    }
    const jk = toJamoKey(hw);
    if (ko.jamoKey && jk !== ko.jamoKey && jk.startsWith(ko.jamoKey)) best = Math.max(best, 600);
    if (ko.romanizedJamoPrefixes.some((p) => p.length > 0 && jk.startsWith(p))) {
      best = Math.max(best, 560);
    }
  }
  return best;
}

export interface RankDictionaryOptions {
  packIds?: readonly DictionaryPackId[];
  limit?: number;
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

  const scored: Array<{ entry: DictionaryEntry; score: number }> = [];

  for (const entry of candidates) {
    if (allowedPacks && !allowedPacks.has(entry.packId)) continue;

    let score: number;
    const hwLower = entry.headword.normalize('NFC').toLowerCase();

    if (!q.lower) {
      score = 10;
    } else if (hwLower === q.lower) {
      score = 1000;
    } else if (entry.altForms?.some((a) => a.normalize('NFC').toLowerCase() === q.lower)) {
      score = 920;
    } else if (
      entry.readings.some((r) => {
        const rl = r.normalize('NFC').toLowerCase();
        const rKana = foldKatakanaToHiragana(rl).replace(/[.・\-\s]+/g, '');
        const rCompact = stripDiacriticsAndTones(rl).replace(/[^a-z0-9]/g, '');
        return (
          rl === q.lower ||
          (q.kanaFolded.length > 0 && rKana === q.kanaFolded) ||
          (q.latinCompact.length > 0 && rCompact === q.latinCompact)
        );
      })
    ) {
      score = 840;
    } else if (entry.eumhun?.some((eh) => eh.normalize('NFC').toLowerCase().includes(q.lower))) {
      score = 780;
    } else if (
      entry.meanings.some((m) => {
        const ml = m.toLowerCase();
        return ml === q.lower || ml.split(/[;,/()]+/).some((part) => part.trim() === q.lower);
      })
    ) {
      score = 760;
    } else if (
      hwLower.startsWith(q.lower) ||
      entry.readings.some((r) => {
        const rKana = foldKatakanaToHiragana(r.toLowerCase()).replace(/[.・\-\s]+/g, '');
        const rCompact = stripDiacriticsAndTones(r.toLowerCase()).replace(/[^a-z0-9]/g, '');
        return (
          (q.kanaFolded.length > 0 && rKana.startsWith(q.kanaFolded)) ||
          (q.latinCompact.length > 0 && rCompact.startsWith(q.latinCompact))
        );
      })
    ) {
      score = 680;
    } else if (
      entry.meanings.some((m) =>
        m
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .some((w) => w === q.latinStripped),
      )
    ) {
      score = 640;
    } else if (
      hwLower.includes(q.lower) ||
      entry.meanings.some((m) => m.toLowerCase().includes(q.lower)) ||
      entry.searchTokens.some(
        (t) =>
          t.startsWith(q.lower) ||
          (q.kanaFolded.length > 0 && t.startsWith(q.kanaFolded)) ||
          (q.latinCompact.length > 0 && t.startsWith(q.latinCompact)),
      )
    ) {
      score = 500;
    } else {
      score = 0;
    }

    // Korean-specific matches (deinflection, romanization, 초성, jamo prefix, English equivalents)
    if (q.lower && score < 1000) {
      score = Math.max(score, koreanMatchScore(entry, ko, q.raw));
    }
    if (score <= 0) continue;

    // Gentle tie-breakers: shorter headwords, Hanja education grade, frequency rank, learner level
    if (entry.grade?.toLowerCase().includes('education')) {
      score += 15;
    }
    if (entry.level) {
      score += LEVEL_BONUS[entry.level];
    }
    if (entry.frequency !== undefined && entry.frequency > 0) {
      score += Math.max(0, 20 - Math.log10(entry.frequency) * 4);
    }
    score -= Math.min(10, entry.headword.length * 0.5);

    scored.push({ entry, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.headword.length - b.entry.headword.length ||
      (a.entry.id < b.entry.id ? -1 : 1),
  );

  return scored.slice(0, limit).map((s) => s.entry);
}
