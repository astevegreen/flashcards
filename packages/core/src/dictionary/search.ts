import type { DictionaryEntry, DictionaryPackId } from './types.ts';

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
  entry: Pick<DictionaryEntry, 'headword' | 'altForms' | 'readings' | 'meanings' | 'eumhun'>,
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

  return [...tokens];
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
      continue;
    }

    // Gentle tie-breakers: shorter headwords, Hanja education grade, frequency rank
    if (entry.grade?.toLowerCase().includes('education')) {
      score += 15;
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
