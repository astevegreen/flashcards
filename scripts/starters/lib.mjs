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
  while (end > 0 && entry.codePointAt(end - 1) >= 48 && entry.codePointAt(end - 1) <= 57) end--;
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
  if (entity?.type !== 'lexeme') throw new Error(`${id}: not a lexeme in EntityData JSON`);
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
 * unambiguous match are skipped rather than guessed. A row whose word, Hanja and meaning all
 * equal an earlier note's (one word listed under two parts of speech, e.g. 이 as pronoun and
 * determiner) would be an identical card: it is merged into that note as an extra tag instead.
 * `overrides` (see `glossOverride`) replaces a note's Wikidata gloss with the app's own wording,
 * after that merge, and the note's provenance then records the edit (`meaningEdited`).
 */
export function buildKoreanNotes({ niklRows, lexemes, size, maxGlosses = 3, overrides = {} }) {
  const byLemma = indexLexemesByHangul(lexemes);
  const homographs = countHomographs(niklRows);
  const rows = niklRows
    .filter((r) => r.grade === 'A' && NIKL_POS.has(r.pos))
    .toSorted((a, b) => a.rank - b.rank || compareCodeUnits(a.entry, b.entry));
  const used = new Set();
  const notes = [];
  /** `word␟hanja␟meaning` → the note already showing that card. */
  const byCard = new Map();
  for (const row of rows) {
    if (notes.length === size) break;
    const candidates = (byLemma.get(row.word) ?? []).filter((l) => !used.has(l.id));
    const lexeme = uniqueMatch(row, candidates, homographs);
    if (lexeme === undefined) continue;
    used.add(lexeme.id);
    const pos = NIKL_POS.get(row.pos);
    const hanja = hanOnly(row.origin);
    const meaning = collectGlosses([lexeme], maxGlosses).join('; ');
    const cardKey = `${row.word}␟${hanja}␟${meaning}`;
    const same = byCard.get(cardKey);
    if (same !== undefined) {
      if (!same.tags.includes(pos.tag)) same.tags.push(pos.tag);
      continue;
    }
    const key = `nikl:${row.entry}:${pos.tag}`;
    const edited = glossOverride(overrides, key, row.word, meaning);
    const note = {
      key,
      fields: {
        word: row.word,
        hanja,
        meaning: edited ?? meaning,
        example: '',
        // Learner content only: the deck's credits live at deck level (see `meaningSource`).
        notes: '',
      },
      tags: ['nikl-a', pos.tag],
      ...meaningProvenance(`Wikidata ${lexeme.id}`, edited),
    };
    byCard.set(cardKey, note);
    notes.push(note);
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
    else mandarin.set(code, value.trim().split(' '));
  }
  return { pinlu, definition, mandarin };
}

/** kSimplifiedVariant (Unihan_Variants.txt) by code point: the simplified forms of a character. */
export function parseSimplifiedVariants(variantsText) {
  const variants = new Map();
  for (const raw of variantsText.split('\n')) {
    if (!raw.startsWith('U+')) continue;
    const [cp, field, value] = raw.replace(/\r$/, '').split('\t');
    if (field !== 'kSimplifiedVariant' || value === undefined) continue;
    variants.set(codePointOf(cp), value.trim().split(' ').map(codePointOf));
  }
  return variants;
}

/** Code points whose kSimplifiedVariant names only other characters (traditional-only forms). */
export function traditionalOnly(simplifiedVariants) {
  const traditional = new Set();
  for (const [cp, targets] of simplifiedVariants) {
    if (!targets.includes(cp)) traditional.add(cp);
  }
  return traditional;
}

function hexCodePoint(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** True for a pinyin syllable with a tone mark (after NFD: macron, acute, caron or grave). */
export function hasToneMark(pinyin) {
  return /[̀́̄̌]/u.test(pinyin.normalize('NFD'));
}

/**
 * The reading a card shows: kMandarin's first (zh-Hans) value, unless that is a neutral-tone
 * particle reading and kMandarin also gives a toned one (地 `de dì`): the kDefinition gloss is
 * the toned word's ("earth; soil"), so the card shows that and lists the particle as "also read".
 */
export function cardReading(values) {
  const first = values[0];
  if (hasToneMark(first)) return first;
  return values.find((v) => hasToneMark(v)) ?? first;
}

/** kDefinition without its Cantonese-only senses (`manifest; (Cant.) to wear` → `manifest`). */
export function mandarinDefinition(definition) {
  return definition
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('(Cant.)'))
    .join('; ');
}

/**
 * kHanyuPinlu counts that belong to the character itself. A character whose simplified variants
 * include another character (著 → 着, 著) is often given that variant's counts too: a reading
 * with exactly the same count in a simplified variant is that variant's, so it is not counted.
 */
function ownCounts(cp, counts, pinlu, simplifiedVariants) {
  const others = (simplifiedVariants.get(cp) ?? []).filter((v) => v !== cp);
  if (others.length === 0) return counts;
  const shared = new Set();
  for (const v of others) {
    for (const r of pinlu.get(v) ?? []) shared.add(`${r.pinyin}(${r.count})`);
  }
  return counts.filter((r) => !shared.has(`${r.pinyin}(${r.count})`));
}

/**
 * The Mandarin starter deck: the `size` most frequent simplified characters of modern Mandarin by
 * the kHanyuPinlu counts (from 《現代漢語頻率詞典》, summed over the character's own readings, see
 * `ownCounts`), with their kMandarin pinyin (see `cardReading`) and the Unihan English definition
 * without Cantonese-only senses. Traditional-only forms are left out. Ties break by code point.
 * `overrides` (see `glossOverride`) replaces a kDefinition gloss with the app's own wording, and
 * the note's provenance then records the edit (`meaningEdited`). The Notes field holds only the
 * character's other readings ("Also read: …"), never a credit.
 */
export function buildMandarinNotes({
  readings,
  simplifiedVariants,
  unihanVersion,
  size,
  overrides = {},
}) {
  const { pinlu, definition, mandarin } = readings;
  const traditional = traditionalOnly(simplifiedVariants);
  const ranked = [...pinlu.entries()]
    .filter(([cp]) => !traditional.has(cp) && mandarin.has(cp))
    .filter(([cp]) => mandarinDefinition(definition.get(cp) ?? '') !== '')
    .map(([cp, counts]) => ({ cp, counts: ownCounts(cp, counts, pinlu, simplifiedVariants) }))
    .filter(({ counts }) => counts.length > 0)
    .map((r) => ({ ...r, total: r.counts.reduce((sum, c) => sum + c.count, 0) }))
    .toSorted((a, b) => b.total - a.total || a.cp - b.cp)
    .slice(0, size);
  return ranked.map(({ cp, counts }) => {
    const reading = cardReading(mandarin.get(cp));
    const others = counts.map((r) => r.pinyin).filter((p) => p !== reading);
    const key = `unihan:${hexCodePoint(cp)}`;
    const word = String.fromCodePoint(cp);
    const meaning = mandarinDefinition(definition.get(cp));
    const edited = glossOverride(overrides, key, word, meaning);
    return {
      key,
      fields: {
        word,
        reading,
        meaning: edited ?? meaning,
        example: '',
        // Learner content only (other readings); the credits live at deck level.
        notes: others.length > 0 ? `Also read: ${others.join(', ')}.` : '',
      },
      tags: ['hanzi-common'],
      ...meaningProvenance(`Unihan ${unihanVersion} kDefinition`, edited),
    };
  });
}

/**
 * Per-note provenance of the card's meaning, kept beside the fields rather than in them: it is
 * never revealed on a card and `buildStarterDeckEvents` does not copy it into events. The licences
 * are satisfied at deck level (catalog `sources`, the deck description, About & Open Data
 * Licenses and THIRD-PARTY-NOTICES.txt); this records which upstream record each meaning came
 * from and whether the app reworded it (`content/starters/gloss-overrides.json`).
 */
function meaningProvenance(source, edited) {
  return edited === undefined
    ? { meaningSource: source }
    : { meaningSource: source, meaningEdited: true };
}

// ---------------------------------------------------------------------------------------------
// Gloss overrides (content/starters/gloss-overrides.json)
// ---------------------------------------------------------------------------------------------

/**
 * The app's own wording for one note's meaning, or undefined when the note has no override.
 * `overrides` maps a stable note key to `{ word, upstream, meaning }`: `word` must be the note's
 * front and `upstream` exactly the gloss the build derived from the pinned source, so a changed
 * source or key never keeps a stale override silently (the build fails and the entry is reviewed).
 */
export function glossOverride(overrides, key, word, upstream) {
  if (!Object.hasOwn(overrides, key)) return undefined;
  const entry = overrides[key];
  if (entry.word !== word) {
    throw new Error(
      `gloss override ${key}: written for "${entry.word}", but the note is "${word}"`,
    );
  }
  if (entry.upstream !== upstream) {
    throw new Error(
      `gloss override ${key}: the source gloss is now "${upstream}", not "${entry.upstream}"; review the override`,
    );
  }
  if (typeof entry.meaning !== 'string' || entry.meaning.trim() !== entry.meaning) {
    throw new Error(`gloss override ${key}: meaning must be trimmed text`);
  }
  if (entry.meaning === '' || entry.meaning === upstream) {
    throw new Error(`gloss override ${key}: meaning is empty or equals the source gloss`);
  }
  return entry.meaning;
}

/**
 * The gloss each reworded note showed before its override existed: starter decks 1.0.0 shipped
 * the derived upstream gloss everywhere, and the overrides came in 1.1.0 (PR #28). `glossOverride`
 * has already checked that each entry's `upstream` equals what the pinned source still derives,
 * so this is the exact 1.0.0 value, keyed by note key in deck order. The starter-deck upgrade
 * (`packages/core/src/starters/upgrade.ts`) replaces a meaning only while it still equals it.
 */
export function glossesBeforeOverrides(notes, overrides) {
  const out = {};
  for (const note of notes) {
    if (note.meaningEdited === true) out[note.key] = overrides[note.key].upstream;
  }
  return out;
}

/** Fails when an override names a note the deck does not have (a typo, or a dropped word). */
export function checkOverridesUsed(overrides, notes, deck) {
  const keys = new Set(notes.map((n) => n.key));
  const unused = Object.keys(overrides).filter((k) => !keys.has(k));
  if (unused.length > 0) {
    throw new Error(`${deck}: gloss overrides for notes not in the deck: ${unused.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Deck assembly and rendering
// ---------------------------------------------------------------------------------------------

/** Source credits belong at deck level, never in a field a card reveals (Notes, Example). */
const CREDIT_IN_FIELD = /\b(?:KOGL|CC0|Wikidata|Unihan|NIKL|Licen[cs]e)\b/;

/**
 * Validates generated notes: unique keys, non-empty front/meaning, plain text only, and no source
 * credit in the revealed Notes/Example fields (credits are deck-level, see `meaningProvenance`).
 */
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
    for (const field of ['notes', 'example']) {
      if (CREDIT_IN_FIELD.test(note.fields[field] ?? '')) {
        throw new Error(`note ${note.key} has a source credit in its ${field} field`);
      }
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

/**
 * Source of the module with each deck's 1.0.0 glosses (see `glossesBeforeOverrides`):
 * `{ [deckSlug]: { [noteKey]: gloss } }`. Loaded only by the starter-deck upgrade.
 */
export function renderLegacyGlossesModule(tables) {
  return (
    GENERATED_HEADER +
    "import type { StarterLegacyGlosses } from '../types.ts';\n\n" +
    '/** The gloss each reworded starter note showed in 1.0.0, before the 1.1.0 gloss overrides. */\n' +
    `const glosses: StarterLegacyGlosses = ${JSON.stringify(tables, null, 2)};\n\n` +
    'export default glosses;\n'
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
