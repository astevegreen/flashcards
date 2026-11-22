/**
 * Pure, deterministic builders for the curated onboarding starter decks (Phase 14 Stream D).
 *
 * No I/O, no Date, no randomness: every function maps raw upstream text (or already-parsed
 * records) to plain data, and every ordering uses an explicit comparator (numeric, or code-unit
 * comparison like `compareCodeUnits` in packages/core/src/study/queue.ts). The same inputs always
 * give byte-identical output. `scripts/build-starter-decks.mjs` does the file reading and writing.
 */

/** Code-unit string order (identical to `compareCodeUnits` in packages/core/src/study/queue.ts). */
export function compareCodeUnits(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Lexeme ids (`L123`) in numeric order, so older lexemes come first. */
export function compareLexemeIds(a, b) {
  return Number(a.slice(1)) - Number(b.slice(1)) || compareCodeUnits(a, b);
}

// ---------------------------------------------------------------------------------------------
// NIKL 한국어 학습용 어휘 목록 (2003)
// ---------------------------------------------------------------------------------------------

/**
 * Parses the NIKL learning-vocabulary list: a header line `순위 단어 품사 풀이 등급` and one
 * tab-separated row per entry, e.g. `898\t가격03\t명\t價格\tB`. The trailing digits of `단어`
 * are the dictionary homograph number; `풀이` is the Hanja origin (or a short gloss) when present.
 */
export function parseNiklList(text) {
  const rows = [];
  for (const raw of text.split('\n')) {
    const cols = raw.replace(/\r$/, '').split('\t');
    if (cols.length < 5) continue;
    const rank = Number.parseInt(cols[0], 10);
    if (!Number.isInteger(rank)) continue;
    const entry = cols[1].trim();
    const word = stripHomographNumber(entry);
    if (word === '') continue;
    rows.push({
      rank,
      entry,
      word,
      pos: cols[2].trim(),
      origin: cols[3].trim(),
      grade: cols[4].trim(),
    });
  }
  return rows;
}

/** `가다01` → `가다` (only trailing ASCII digits are removed). */
export function stripHomographNumber(entry) {
  let end = entry.length;
  while (end > 0 && entry.charCodeAt(end - 1) >= 48 && entry.charCodeAt(end - 1) <= 57) end--;
  return entry.slice(0, end);
}

/** The Han characters of a string, in order (`可能-` → `可能`, `可能하다` → `可能`). */
export function hanOnly(text) {
  return [...text].filter((ch) => /\p{Script=Han}/u.test(ch)).join('');
}

// ---------------------------------------------------------------------------------------------
// Wikidata lexemes
// ---------------------------------------------------------------------------------------------

/**
 * Reduces one revision of a Wikidata lexeme (Special:EntityData JSON) to the fields the build
 * uses. The result is what the lock file's sha256 covers, so a change in Wikidata's JSON
 * serialization never breaks a rebuild, while any change to the data does.
 */
export function normalizeLexeme(entityJson, id) {
  const entity = entityJson?.entities?.[id];
  if (!entity || entity.type !== 'lexeme')
    throw new Error(`${id}: not a lexeme in EntityData JSON`);
  const lemmas = Object.values(entity.lemmas ?? {})
    .map((l) => [l.language, l.value])
    .toSorted((a, b) => compareCodeUnits(a[0], b[0]));
  const glosses = [];
  for (const sense of entity.senses ?? []) {
    const en = sense.glosses?.en?.value;
    if (typeof en === 'string' && en.trim() !== '') glosses.push(en.trim());
  }
  return {
    id,
    revision: entity.lastrevid,
    language: entity.language,
    category: entity.lexicalCategory,
    lemmas,
    glosses,
  };
}

/** Canonical JSON of a normalized lexeme (the input to its lock-file sha256). */
export function canonicalLexemeJson(lexeme) {
  return JSON.stringify({
    id: lexeme.id,
    revision: lexeme.revision,
    language: lexeme.language,
    category: lexeme.category,
    lemmas: lexeme.lemmas,
    glosses: lexeme.glosses,
  });
}

// Wikidata lexical categories.
const NOUN = 'Q1084';
const PROPER_NOUN = 'Q147276';
const VERB = 'Q24905';
const ADJECTIVE = 'Q34698';
const ADVERB = 'Q380057';
const PRONOUN = 'Q36224';
const NUMERAL = 'Q63116';
const DETERMINER = 'Q576271';
const INTERJECTION = 'Q83034';
const CLASSIFIER = 'Q63153';

/**
 * NIKL part of speech → the Wikidata lexical categories a matching Korean lexeme may have, plus
 * the tag the note gets. Korean descriptive verbs (형용사) are often entered as verbs on Wikidata.
 * 조사 (particles), 보조 용언 and unanalysable entries are not offered as starter words.
 */
export const NIKL_POS = new Map([
  ['명', { tag: 'noun', categories: [NOUN] }],
  ['의', { tag: 'dependent-noun', categories: [NOUN, CLASSIFIER] }],
  ['대', { tag: 'pronoun', categories: [PRONOUN] }],
  ['수', { tag: 'numeral', categories: [NUMERAL] }],
  ['동', { tag: 'verb', categories: [VERB] }],
  ['형', { tag: 'adjective', categories: [ADJECTIVE, VERB] }],
  ['관', { tag: 'determiner', categories: [DETERMINER, ADJECTIVE] }],
  ['부', { tag: 'adverb', categories: [ADVERB] }],
  ['감', { tag: 'interjection', categories: [INTERJECTION] }],
  ['고', { tag: 'proper-noun', categories: [PROPER_NOUN] }],
]);

/** The lexeme's Hanja spelling (`ko-hani`, or a mixed-script `ko-kore` lemma), Han characters only. */
function lexemeHanja(lexeme) {
  for (const [lang, value] of lexeme.lemmas) {
    if (lang === 'ko-hani' || lang === 'ko-kore') {
      const han = hanOnly(value);
      if (han !== '') return han;
    }
  }
  return '';
}

function lexemeHangul(lexeme) {
  return lexeme.lemmas.find(([lang]) => lang === 'ko')?.[1];
}

/**
 * A lexeme fits a NIKL row only when their Hanja agree exactly: a Sino-Korean row needs a lexeme
 * recording the same Hanja, and a native row a lexeme recording none. This keeps a homograph
 * (`씨` 氏 "Mr." vs `씨` "seed") from picking up the other word's meaning.
 */
function hanjaAgrees(row, lexeme) {
  return hanOnly(row.origin) === lexemeHanja(lexeme);
}

/** `word␟pos` → how many NIKL entries (any level) share that spelling and part of speech. */
function countHomographs(niklRows) {
  const counts = new Map();
  for (const r of niklRows) {
    const key = `${r.word}␟${r.pos}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The one lexeme that unambiguously matches a row, or undefined. A native row whose spelling and
 * part of speech are shared by another NIKL entry is ambiguous (no Hanja tells them apart), and
 * so is any row more than one unused lexeme could match.
 */
function uniqueMatch(row, candidates, homographs) {
  const native = hanOnly(row.origin) === '';
  if (native && (homographs.get(`${row.word}␟${row.pos}`) ?? 0) > 1) return undefined;
  const pos = NIKL_POS.get(row.pos);
  const matches = candidates.filter(
    (l) => pos.categories.includes(l.category) && hanjaAgrees(row, l),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Up to `max` distinct glosses, in lexeme order then sense order. */
function collectGlosses(lexemes, max) {
  const out = [];
  const seen = new Set();
  for (const lexeme of lexemes) {
    for (const gloss of lexeme.glosses) {
      const key = gloss.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(gloss);
      if (out.length === max) return out;
    }
  }
  return out;
}

function indexLexemesByHangul(lexemes) {
  const byLemma = new Map();
  const sorted = lexemes.toSorted((a, b) => compareLexemeIds(a.id, b.id));
  for (const lexeme of sorted) {
    const lemma = lexemeHangul(lexeme);
    if (lemma === undefined || lexeme.glosses.length === 0) continue;
    const list = byLemma.get(lemma) ?? [];
    list.push(lexeme);
    byLemma.set(lemma, list);
  }
  return byLemma;
}

/**
 * The Korean starter deck: NIKL level-A (초급) words in NIKL frequency-rank order, each with the
 * English glosses of the one Wikidata lexeme that unambiguously matches its spelling, part of
 * speech and Hanja (see `uniqueMatch`). A lexeme is used for one row only; rows without an
 * unambiguous match are skipped rather than guessed.
 */
export function buildKoreanNotes({ niklRows, lexemes, size, maxGlosses = 3 }) {
  const byLemma = indexLexemesByHangul(lexemes);
  const homographs = countHomographs(niklRows);
  const rows = niklRows
    .filter((r) => r.grade === 'A' && NIKL_POS.has(r.pos))
    .toSorted((a, b) => a.rank - b.rank || compareCodeUnits(a.entry, b.entry));
  const used = new Set();
  const notes = [];
  for (const row of rows) {
    if (notes.length === size) break;
    const candidates = (byLemma.get(row.word) ?? []).filter((l) => !used.has(l.id));
    const lexeme = uniqueMatch(row, candidates, homographs);
    if (lexeme === undefined) continue;
    used.add(lexeme.id);
    const pos = NIKL_POS.get(row.pos);
    notes.push({
      key: `nikl:${row.entry}:${pos.tag}`,
      fields: {
        word: row.word,
        hanja: hanOnly(row.origin),
        meaning: collectGlosses([lexeme], maxGlosses).join('; '),
        example: '',
        notes: `Word list: NIKL 한국어 학습용 어휘 목록 (2003), KOGL Type 1. English: Wikidata ${lexeme.id} (CC0).`,
      },
      tags: ['nikl-a', pos.tag],
    });
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Unihan (Unicode License v3)
// ---------------------------------------------------------------------------------------------

/** `U+7684` → 0x7684. */
function codePointOf(field) {
  return Number.parseInt(field.slice(2), 16);
}

/** Parses `pinyin(count)` tokens of a kHanyuPinlu value, most frequent first (stable). */
export function parseHanyuPinlu(value) {
  const readings = [];
  for (const token of value.split(' ')) {
    const open = token.lastIndexOf('(');
    if (open <= 0 || !token.endsWith(')')) continue;
    const count = Number.parseInt(token.slice(open + 1, -1), 10);
    if (!Number.isInteger(count)) continue;
    readings.push({ pinyin: token.slice(0, open), count });
  }
  return readings
    .map((r, i) => ({ ...r, i }))
    .toSorted((a, b) => b.count - a.count || a.i - b.i)
    .map(({ pinyin, count }) => ({ pinyin, count }));
}

const READING_FIELDS = new Set(['kHanyuPinlu', 'kDefinition', 'kMandarin']);

/**
 * Reads kHanyuPinlu, kDefinition and kMandarin from Unihan_Readings.txt, keyed by code point.
 * kMandarin's first value is the customary reading (the zh-Hans one when two are given).
 */
export function parseUnihanReadings(text) {
  const pinlu = new Map();
  const definition = new Map();
  const mandarin = new Map();
  for (const raw of text.split('\n')) {
    if (!raw.startsWith('U+')) continue;
    const [cp, field, value] = raw.replace(/\r$/, '').split('\t');
    if (value === undefined || !READING_FIELDS.has(field)) continue;
    const code = codePointOf(cp);
    if (field === 'kHanyuPinlu') pinlu.set(code, parseHanyuPinlu(value));
    else if (field === 'kDefinition') definition.set(code, value.trim());
    else mandarin.set(code, value.trim().split(' ')[0]);
  }
  return { pinlu, definition, mandarin };
}

/** Code points whose kSimplifiedVariant (Unihan_Variants.txt) names only other characters. */
export function parseTraditionalOnly(variantsText) {
  const traditional = new Set();
  for (const raw of variantsText.split('\n')) {
    if (!raw.startsWith('U+')) continue;
    const [cp, field, value] = raw.replace(/\r$/, '').split('\t');
    if (field !== 'kSimplifiedVariant' || value === undefined) continue;
    const self = codePointOf(cp);
    const targets = value.trim().split(' ').map(codePointOf);
    if (!targets.includes(self)) traditional.add(self);
  }
  return traditional;
}

function hexCodePoint(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * The Mandarin starter deck: the `size` most frequent simplified characters of modern Mandarin by
 * the kHanyuPinlu counts (from 《現代漢語頻率詞典》, summed over readings), with their customary
 * kMandarin pinyin and the Unihan English definition. Traditional-only forms are left out. Ties
 * break by code point.
 */
export function buildMandarinNotes({ readings, traditional, unihanVersion, size }) {
  const { pinlu, definition, mandarin } = readings;
  const ranked = [...pinlu.entries()]
    .filter(([cp, counts]) => counts.length > 0 && definition.has(cp) && mandarin.has(cp))
    .filter(([cp]) => !traditional.has(cp))
    .map(([cp, counts]) => ({ cp, counts, total: counts.reduce((sum, r) => sum + r.count, 0) }))
    .toSorted((a, b) => b.total - a.total || a.cp - b.cp)
    .slice(0, size);
  return ranked.map(({ cp, counts }) => {
    const reading = mandarin.get(cp);
    const others = counts.map((r) => r.pinyin).filter((p) => p !== reading);
    const also = others.length > 0 ? `Also read: ${others.join(', ')}. ` : '';
    return {
      key: `unihan:${hexCodePoint(cp)}`,
      fields: {
        word: String.fromCodePoint(cp),
        reading,
        meaning: definition.get(cp),
        example: '',
        notes: `${also}Source: Unicode Unihan ${unihanVersion} (kHanyuPinlu, kMandarin, kDefinition), Unicode License v3.`,
      },
      tags: ['hanzi-common'],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Deck assembly and rendering
// ---------------------------------------------------------------------------------------------

/** Validates generated notes: unique keys, non-empty front/meaning, plain text only. */
export function validateNotes(notes, frontField) {
  const keys = new Set();
  for (const note of notes) {
    if (keys.has(note.key)) throw new Error(`duplicate note key ${note.key}`);
    keys.add(note.key);
    if (!note.fields[frontField] || !note.fields.meaning) {
      throw new Error(`note ${note.key} has an empty ${frontField} or meaning`);
    }
    for (const value of Object.values(note.fields)) {
      if (/[<>]/.test(value)) throw new Error(`note ${note.key} contains markup: ${value}`);
    }
  }
}

/** Header comment for every generated module. */
export const GENERATED_HEADER =
  '// Generated by scripts/build-starter-decks.mjs from pinned open data. Do not edit by hand.\n';

/** Source of one deck-content module (unformatted; the build runs Prettier over it). */
export function renderDeckModule(deck) {
  const data = { slug: deck.slug, notes: deck.notes };
  return (
    GENERATED_HEADER +
    "import type { StarterDeckContent } from '../types.ts';\n\n" +
    `const deck: StarterDeckContent = ${JSON.stringify(data, null, 2)};\n\n` +
    'export default deck;\n'
  );
}

/** Source of the tiny catalog module onboarding lists (no note content). */
export function renderCatalogModule(infos) {
  return (
    GENERATED_HEADER +
    "import type { StarterDeckInfo } from '../types.ts';\n\n" +
    `export const STARTER_CATALOG: readonly StarterDeckInfo[] = ${JSON.stringify(infos, null, 2)};\n`
  );
}
