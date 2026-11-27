import { BUILTIN_NOTE_TYPE_IDS } from '../model/presets.ts';
import { ownField } from '../model/note-fields.ts';
import type { NoteType } from '../model/types.ts';
import { normalizeTagList } from '../tags/index.ts';
import { splitTagCell } from './tag-cell.ts';
import {
  columnDisplayName,
  joinNotes,
  notesFieldKey,
  notesLine,
  type ColumnTarget,
} from './column-target.ts';

export * from './column-target.ts';

/**
 * The Bring my cards column-mapping guess (pure). Given a table (row 0 may be headers) and the
 * target note type, it proposes where each column goes, from the header names first, then from
 * what the first rows hold, then from the column order. The user can change every guess.
 */

export type ColumnGuessReason = 'header' | 'content' | 'position' | 'empty' | 'unknown';

export interface ColumnGuess {
  index: number;
  /** The header text, or `Column N` when the table has no header row. */
  header: string;
  /** Up to {@link SAMPLE_COUNT} non-empty values from the first rows. */
  samples: string[];
  target: ColumnTarget;
  reason: ColumnGuessReason;
}

export interface ColumnMappingGuess {
  hasHeaderRow: boolean;
  columns: ColumnGuess[];
}

/** Rows read to judge a column's content. */
const CONTENT_ROWS = 20;
const SAMPLE_COUNT = 3;

type Role =
  'front' | 'meaning' | 'example' | 'reading' | 'notes' | 'tags' | 'card_id' | 'image' | 'audio';

/**
 * Header words people use, by role (English, Korean, some Japanese/Chinese). Matched after the
 * note type's own field keys and labels, and after trailing numbers are dropped (`category1`).
 * One `|`-separated list per role.
 */
const HEADER_SYNONYMS: Readonly<Record<Role, string>> = {
  front:
    'word|words|term|front|vocab|vocabulary|expression|phrase|question|korean|hangul|hangeul|japanese|chinese|hanzi|kanji|target|단어|어휘|표현|한국어|앞면|単語|語彙|词|词语|单词',
  meaning:
    'definition|definitions|meaning|meanings|translation|english|gloss|back|answer|english meaning|korean meaning|뜻|의미|번역|영어|정의|뒷면|意味|意思|释义|翻译',
  example:
    'example|examples|example sentence|sentence|sentences|usage|context|예문|예시|문장|例文|例句',
  reading:
    'reading|pronunciation|romanization|romanisation|romaji|pinyin|kana|furigana|hanja|ipa|발음|한자|読み|拼音',
  notes: 'notes|note|memo|comment|comments|remarks|extra|메모|비고|참고|メモ|备注',
  tags: 'tag|tags|category|categories|topic|topics|level|lesson|unit|chapter|group|section|deck|subdeck|theme|pos|part of speech|type|카테고리|분류|주제|단원|레벨|등급|품사|과|タグ|分類|品詞|标签|分类|词性',
  card_id: 'card id|card_id|cardid|id|source_key|note id|guid',
  image: 'image|picture|photo|img|그림|사진|画像|图片',
  audio: 'audio|sound|pronunciation audio|mp3|소리|음성|音声|音频',
};

const SYNONYM_ROLE = new Map<string, Role>();
for (const [role, words] of Object.entries(HEADER_SYNONYMS) as [Role, string][]) {
  for (const word of words.split('|')) SYNONYM_ROLE.set(word, role);
}

/** NFC, lowercase, single spaces, `_`/`-` as spaces, outer brackets/colons dropped. */
function normalizeHeader(header: string): string {
  return header
    .normalize('NFC')
    .toLowerCase()
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/[():：]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** `category 2` / `category2` / `예문1` -> `category` / `예문` (the trailing number dropped). */
function headerBase(norm: string): string {
  let end = norm.length;
  while (end > 0 && isAsciiDigit(norm[end - 1] ?? '')) end -= 1;
  return norm.slice(0, end).trim();
}

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** `Text 3` (Flashcards Deluxe positional column) -> 2. */
function deluxeIndex(norm: string): number | undefined {
  const match = /^text\s*(\d+)$/.exec(norm);
  return match ? Number(match[1]) - 1 : undefined;
}

function roleForHeader(norm: string): Role | undefined {
  return SYNONYM_ROLE.get(norm) ?? SYNONYM_ROLE.get(headerBase(norm));
}

// ---------------------------------------------------------------------------------------------
// Content profile of a column
// ---------------------------------------------------------------------------------------------

type Script = 'hangul' | 'kana' | 'han' | 'latin' | 'other';

function scriptOf(cp: number): Script | undefined {
  if (
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f)
  )
    return 'hangul';
  if (cp >= 0x3040 && cp <= 0x30ff) return 'kana';
  if (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  )
    return 'han';
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f))
    return 'latin';
  if (cp > 0x7f) return 'other';
  return undefined; // digits, punctuation, spaces
}

interface ScriptCounts {
  hangul: number;
  kana: number;
  han: number;
  latin: number;
  other: number;
}

function countScripts(text: string, into: ScriptCounts): void {
  for (const ch of text) {
    const script = scriptOf(ch.codePointAt(0) ?? 0);
    if (script) into[script] += 1;
  }
}

function emptyCounts(): ScriptCounts {
  return { hangul: 0, kana: 0, han: 0, latin: 0, other: 0 };
}

function cjkShare(c: ScriptCounts): number {
  const letters = c.hangul + c.kana + c.han + c.latin + c.other;
  return letters === 0 ? 0 : (c.hangul + c.kana + c.han) / letters;
}

/** The main script of `text`, or `undefined` for text with no letters. */
function dominantScript(text: string): Script | undefined {
  const counts = emptyCounts();
  countScripts(text, counts);
  let best: Script | undefined;
  let bestCount = 0;
  for (const script of ['hangul', 'kana', 'han', 'latin', 'other'] as const) {
    if (counts[script] > bestCount) {
      best = script;
      bestCount = counts[script];
    }
  }
  return best;
}

/** A cell holding an image: a stored `media:` hash, a Sheets `=IMAGE(…)` formula, or an image URL. */
const IMAGE_VALUES: readonly RegExp[] = [
  /^media:[0-9a-f]{64}$/i,
  /^=\s*image\s*\(.*\)$/i,
  /^https:\/\/\S+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?\S*)?$/i,
];

function isImageValue(value: string): boolean {
  return IMAGE_VALUES.some((re) => re.test(value));
}
const AUDIO_VALUE =
  /^(?:\[sound:[^\]]+\]|https:\/\/\S+\.(?:mp3|ogg|oga|wav|m4a|aac|opus)(?:\?\S*)?)$/i;

interface ColumnProfile {
  values: string[];
  counts: ScriptCounts;
  avgLength: number;
  avgWords: number;
  distinctRatio: number;
  allImages: boolean;
  allAudio: boolean;
}

function profileColumn(rows: readonly (readonly string[])[], index: number): ColumnProfile {
  const values: string[] = [];
  for (const row of rows.slice(0, CONTENT_ROWS)) {
    const value = (row[index] ?? '').trim();
    if (value) values.push(value);
  }
  const counts = emptyCounts();
  let length = 0;
  let words = 0;
  for (const value of values) {
    countScripts(value, counts);
    length += [...value].length;
    words += value.split(/\s+/).length;
  }
  const n = Math.max(values.length, 1);
  return {
    values,
    counts,
    avgLength: length / n,
    avgWords: words / n,
    distinctRatio: new Set(values).size / n,
    allImages: values.length > 0 && values.every(isImageValue),
    allAudio: values.length > 0 && values.every((v) => AUDIO_VALUE.test(v)),
  };
}

/** Short values that repeat a lot (a level, topic or part of speech). */
function looksLikeCategory(p: ColumnProfile): boolean {
  return p.values.length >= 4 && p.distinctRatio <= 0.5 && p.avgWords <= 3 && p.avgLength <= 24;
}

function looksLikeSentence(p: ColumnProfile): boolean {
  return p.avgWords >= 3 || (cjkShare(p.counts) > 0.5 && p.avgLength >= 12);
}

// ---------------------------------------------------------------------------------------------
// Header row detection
// ---------------------------------------------------------------------------------------------

function isRecognizedHeader(cell: string, noteType: NoteType | undefined): boolean {
  const norm = normalizeHeader(cell);
  if (!norm) return false;
  if (roleForHeader(norm) || deluxeIndex(norm) !== undefined) return true;
  return (noteType?.fields ?? []).some(
    (f) => f.key.toLowerCase() === norm || normalizeHeader(f.label) === norm,
  );
}

/**
 * Whether row 0 holds column names. True when any cell is a name we know. Otherwise false only
 * when row 0 looks like the rows below it: in every filled column its script matches the column's
 * usual script, and at least one of those columns is Korean, Japanese or Chinese (an all-English
 * table with unknown names is assumed to have headers).
 */
export function looksLikeHeaderRow(
  grid: readonly (readonly string[])[],
  noteType?: NoteType,
): boolean {
  const first = grid[0];
  if (!first) return true;
  if (first.some((cell) => isRecognizedHeader(cell, noteType))) return true;
  const rest = grid.slice(1, 1 + CONTENT_ROWS);
  if (rest.length === 0) return true;
  let compared = 0;
  let cjkColumns = 0;
  for (let col = 0; col < first.length; col++) {
    const head = (first[col] ?? '').trim();
    if (!head) continue;
    const below = profileColumn(rest, col);
    if (below.values.length === 0) return true;
    const headScript = dominantScript(head);
    const usual = dominantScript(below.values.join(' '));
    if (headScript !== usual) return true;
    if (usual === 'hangul' || usual === 'kana' || usual === 'han') cjkColumns += 1;
    compared += 1;
  }
  return !(compared > 0 && cjkColumns > 0);
}

// ---------------------------------------------------------------------------------------------
// The guess
// ---------------------------------------------------------------------------------------------

function frontFieldKey(noteType: NoteType): string | undefined {
  return noteType.fields.find((f) => f.sortKey)?.key ?? noteType.fields[0]?.key;
}

const MEANING_KEYS = new Set(['meaning', 'translation', 'explanation', 'definition']);
const EXAMPLE_KEYS = new Set(['example', 'examples', 'compounds']);

/** The note type field a role fills, if it has one. */
function fieldForRole(role: Role, noteType: NoteType): string | undefined {
  const fields = noteType.fields;
  switch (role) {
    case 'front':
      return frontFieldKey(noteType);
    case 'meaning':
      return fields.find((f) => MEANING_KEYS.has(f.key.toLowerCase()))?.key;
    case 'example':
      return fields.find((f) => EXAMPLE_KEYS.has(f.key.toLowerCase()))?.key;
    case 'reading':
      return fields.find((f) => f.kind === 'reading')?.key;
    case 'notes':
      return notesFieldKey(noteType);
    case 'image':
      return fields.find((f) => f.kind === 'image')?.key;
    case 'audio':
      return fields.find((f) => f.kind === 'audio')?.key;
    default:
      return undefined;
  }
}

/** Where a column nobody could place goes: Notes when the note type has it, else nowhere. */
function leftoverTarget(noteType: NoteType): ColumnTarget {
  return notesFieldKey(noteType) ? { kind: 'notes' } : { kind: 'ignore' };
}

interface Draft {
  target?: ColumnTarget;
  reason?: ColumnGuessReason;
}

function exactFieldMatch(norm: string, noteType: NoteType): string | undefined {
  return noteType.fields.find(
    (f) => f.key.toLowerCase() === norm || normalizeHeader(f.label) === norm,
  )?.key;
}

/** What {@link guessColumnMapping} has decided so far. */
interface GuessState {
  noteType: NoteType;
  drafts: Draft[];
  /** Fields that already have a column. */
  taken: Set<string>;
  notesKey: string | undefined;
  cardIdTaken: boolean;
}

/** Sends column `i` to `fieldKey` unless another column has it (Notes takes any number). */
function claimField(
  state: GuessState,
  i: number,
  fieldKey: string | undefined,
  reason: ColumnGuessReason,
): boolean {
  if (!fieldKey) return false;
  if (fieldKey !== state.notesKey && state.taken.has(fieldKey)) return false;
  state.taken.add(fieldKey);
  state.drafts[i] = { target: { kind: 'field', fieldKey }, reason };
  return true;
}

/** Places column `i` by its header: exact field name, Flashcards Deluxe `Text N`, then synonyms. */
function guessFromHeader(state: GuessState, i: number, cell: string): void {
  const { noteType } = state;
  const norm = normalizeHeader(cell);
  if (!norm) return;
  if (claimField(state, i, exactFieldMatch(norm, noteType), 'header')) return;
  const deluxe = deluxeIndex(norm);
  if (deluxe !== undefined && claimField(state, i, noteType.fields[deluxe]?.key, 'header')) return;
  const role = roleForHeader(norm);
  if (role === 'tags') {
    state.drafts[i] = { target: { kind: 'tags' }, reason: 'header' };
  } else if (role === 'card_id') {
    if (state.cardIdTaken) return;
    state.cardIdTaken = true;
    state.drafts[i] = { target: { kind: 'card_id' }, reason: 'header' };
  } else if (role) {
    claimField(state, i, fieldForRole(role, noteType), 'header');
  }
}

interface ContentKeys {
  front: string | undefined;
  meaning: string | undefined;
  example: string | undefined;
}

/** Places column `i` by what it holds: media, CJK words, categories, sentences, meanings. */
function guessFromContent(
  state: GuessState,
  i: number,
  profile: ColumnProfile,
  { front, meaning, example }: ContentKeys,
): void {
  const { noteType, taken } = state;
  if (profile.allImages && claimField(state, i, fieldForRole('image', noteType), 'content')) return;
  if (profile.allAudio && claimField(state, i, fieldForRole('audio', noteType), 'content')) return;
  const isFree = (key: string | undefined): key is string => !!key && !taken.has(key);
  const cjk = cjkShare(profile.counts) > 0.5;
  const sentence = looksLikeSentence(profile);
  if (cjk && !sentence && isFree(front)) {
    claimField(state, i, front, 'content');
  } else if (looksLikeCategory(profile)) {
    state.drafts[i] = { target: { kind: 'tags' }, reason: 'content' };
  } else if (cjk && sentence && isFree(example)) {
    claimField(state, i, example, 'content');
  } else if (!cjk && isFree(meaning) && front && taken.has(front)) {
    claimField(state, i, meaning, 'content');
  }
}

/**
 * Proposes a target for every column of `grid` (row 0 is headers unless `hasHeaderRow` is false;
 * by default {@link looksLikeHeaderRow} decides). Each note type field takes at most one column;
 * Notes and tags take any number. Columns left over go to Notes ("Add to Notes"), empty ones are
 * not imported.
 */
export function guessColumnMapping(
  grid: readonly (readonly string[])[],
  noteType: NoteType,
  options: { hasHeaderRow?: boolean } = {},
): ColumnMappingGuess {
  const hasHeaderRow = options.hasHeaderRow ?? looksLikeHeaderRow(grid, noteType);
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  const headerCells = hasHeaderRow ? (grid[0] ?? []) : [];
  const rows = hasHeaderRow ? grid.slice(1) : grid;
  const headers = Array.from({ length: width }, (_, i) =>
    columnDisplayName(headerCells[i] ?? '', i),
  );
  const profiles = headers.map((_, i) => profileColumn(rows, i));
  const state: GuessState = {
    noteType,
    drafts: headers.map(() => ({})),
    taken: new Set<string>(),
    notesKey: notesFieldKey(noteType),
    cardIdTaken: false,
  };
  const { drafts } = state;

  // 1. Header names: empty columns, exact field names, Flashcards Deluxe `Text N`, synonyms.
  for (let i = 0; i < width; i++) {
    const profile = profiles[i];
    if (!profile || profile.values.length === 0) {
      drafts[i] = { target: { kind: 'ignore' }, reason: 'empty' };
    } else if (hasHeaderRow) {
      guessFromHeader(state, i, headerCells[i] ?? '');
    }
  }

  // 2. Content: media, categories, then the front / example / meaning fields still free.
  const keys: ContentKeys = {
    front: frontFieldKey(noteType),
    meaning: fieldForRole('meaning', noteType),
    example: fieldForRole('example', noteType),
  };
  for (let i = 0; i < width; i++) {
    const profile = profiles[i];
    if (profile && !drafts[i]?.target) guessFromContent(state, i, profile, keys);
  }

  // 3. Position: the first columns nobody placed fill the front, then the meaning.
  for (const fieldKey of [keys.front, keys.meaning]) {
    if (!fieldKey || state.taken.has(fieldKey)) continue;
    const i = drafts.findIndex((d) => !d.target);
    if (i === -1) break;
    claimField(state, i, fieldKey, 'position');
  }

  const columns = headers.map((header, index): ColumnGuess => {
    const draft = drafts[index] ?? {};
    return {
      index,
      header,
      samples: (profiles[index]?.values ?? []).slice(0, SAMPLE_COUNT),
      target: draft.target ?? leftoverTarget(noteType),
      reason: draft.reason ?? 'unknown',
    };
  });
  return { hasHeaderRow, columns };
}

// ---------------------------------------------------------------------------------------------
// Deck setup (note type + language) for a new deck
// ---------------------------------------------------------------------------------------------

const LANGUAGE_BY_SCRIPT: Partial<Record<Script, { noteTypeId: string; language: string }>> = {
  hangul: { noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, language: 'ko' },
  kana: { noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA, language: 'ja' },
  han: { noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH, language: 'zh-Hans' },
};

/**
 * Note type and language for a new deck made from `grid`: a few telling header names first
 * (`Pinyin`, `Eumhun`, `Grammar Point`, …), then the script the table is mostly written in
 * (Korean → Vocabulary (KO); any kana → Japanese; Chinese characters only → Mandarin). Falls back
 * to Vocabulary (KO).
 */
export function guessDeckSetup(
  grid: readonly (readonly string[])[],
  options: { hasHeaderRow?: boolean } = {},
): { noteTypeId: string; language: string } {
  const hasHeaderRow = options.hasHeaderRow ?? looksLikeHeaderRow(grid);
  const fromHeaders = hasHeaderRow ? deckSetupFromHeaders(grid[0] ?? []) : undefined;
  if (fromHeaders) return fromHeaders;
  const counts = emptyCounts();
  for (const row of (hasHeaderRow ? grid.slice(1) : grid).slice(0, CONTENT_ROWS)) {
    for (const cell of row) countScripts(cell, counts);
  }
  const script = deckScript(counts);
  return (
    (script && LANGUAGE_BY_SCRIPT[script]) ?? {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
    }
  );
}

/** A note type and language that a telling header name settles on its own. */
function deckSetupFromHeaders(
  cells: readonly string[],
): { noteTypeId: string; language: string } | undefined {
  const norms = new Set(cells.map(normalizeHeader));
  if (norms.has('eumhun') || norms.has('eumhun 음훈') || norms.has('character'))
    return { noteTypeId: BUILTIN_NOTE_TYPE_IDS.HANJA, language: 'ko' };
  if (norms.has('pinyin'))
    return { noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH, language: 'zh-Hans' };
  if (norms.has('grammar point') || norms.has('pattern'))
    return { noteTypeId: BUILTIN_NOTE_TYPE_IDS.GRAMMAR, language: 'ko' };
  return undefined;
}

/** Any kana (at least as much as Hangul) → Japanese; Hangul → Korean; Chinese characters only → Mandarin. */
function deckScript(counts: ScriptCounts): Script | undefined {
  if (counts.kana > 0 && counts.kana >= counts.hangul) return 'kana';
  if (counts.hangul > 0) return 'hangul';
  if (counts.han > 0) return 'han';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Applying a mapping: preview and checks
// ---------------------------------------------------------------------------------------------

export interface MappedRow {
  fields: Record<string, string>;
  tags: string[];
  cardId: string;
}

/**
 * One row through a mapping, as the CSV importer stores it: fields (two columns into one field are
 * joined by a line break), `Header: value` lines appended to Notes, category cells split on `,`/`;`
 * into tags (`splitTagCell`). A cell is trimmed, like an unquoted CSV cell, unless `quoted` says
 * it was written in quotes (`parseDelimitedText`'s flags): then it keeps its spaces, and a field
 * of spaces only stays, as `buildEventsFromCsv` imports it (C17). A Card ID is always trimmed.
 */
export function applyColumnTargets(
  row: readonly string[],
  headers: readonly string[],
  targets: readonly ColumnTarget[],
  noteType: NoteType,
  quoted?: readonly boolean[],
): MappedRow {
  const fields: Record<string, string> = {};
  const rawTags: string[] = [];
  const notes: string[] = [];
  let cardId = '';
  targets.forEach((target, i) => {
    const cell = row[i] ?? '';
    const keep = quoted?.[i] === true && target.kind !== 'card_id';
    const value = keep ? cell : cell.trim();
    if (!value.trim() && !(keep && target.kind === 'field' && value)) return;
    if (target.kind === 'field') {
      const prev = ownField(fields, target.fieldKey);
      fields[target.fieldKey] = prev ? `${prev}\n${value}` : value;
    } else if (target.kind === 'tags') {
      rawTags.push(...splitTagCell(value));
    } else if (target.kind === 'card_id') {
      if (!cardId) cardId = value;
    } else if (target.kind === 'notes') {
      notes.push(notesLine(headers[i] ?? '', i, value));
    }
  });
  const notesKey = notesFieldKey(noteType);
  if (notesKey && notes.length > 0) fields[notesKey] = joinNotes(ownField(fields, notesKey), notes);
  return { fields, tags: normalizeTagList(rawTags), cardId };
}

/** A CSV grid's quotes (`parseDelimitedTable`): which cells were quoted, and row 1 untrimmed. */
export interface GridQuotes {
  /** `quoted[r][c]`: grid cell `[r][c]` was written in quotes. */
  quoted: readonly (readonly boolean[])[];
  /** Row 1 untrimmed (the grid's row 0 holds trimmed headers), read when it is data. */
  firstRow: readonly string[];
}

/** The first `limit` data rows as they would be imported (rows with no mapped value are skipped). */
export function previewMappedRows(
  grid: readonly (readonly string[])[],
  targets: readonly ColumnTarget[],
  noteType: NoteType,
  options: {
    hasHeaderRow: boolean;
    limit?: number;
    /** The CSV quotes behind `grid`, so the preview keeps what the import keeps. */
    quotes?: GridQuotes;
  },
): MappedRow[] {
  const headerCells = options.hasHeaderRow ? (grid[0] ?? []) : [];
  const headers = targets.map((_, i) => columnDisplayName(headerCells[i] ?? '', i));
  const out: MappedRow[] = [];
  const first = options.hasHeaderRow ? 1 : 0;
  for (let r = first; r < grid.length; r++) {
    const row = (r === 0 ? options.quotes?.firstRow : undefined) ?? grid[r] ?? [];
    // A row of blanks is not imported, even one of quoted spaces (`buildEventsFromCsv`).
    if (!row.some((cell) => cell.trim() !== '')) continue;
    const mapped = applyColumnTargets(row, headers, targets, noteType, options.quotes?.quoted[r]);
    if (Object.keys(mapped.fields).length === 0) continue;
    out.push(mapped);
    if (out.length >= (options.limit ?? SAMPLE_COUNT)) break;
  }
  return out;
}

export interface MappingProblems {
  /** The front field (the note type's sort-key field) has no column. */
  missingFront?: string;
  /** Fields (other than Notes) that two or more columns go to. */
  duplicateFields: string[];
  /** More than one Card ID column. */
  duplicateCardId: boolean;
}

/** What blocks an import: no column for the front, a field chosen twice, two Card ID columns. */
export function mappingProblems(
  targets: readonly ColumnTarget[],
  noteType: NoteType,
): MappingProblems {
  const notesKey = notesFieldKey(noteType);
  const counts = new Map<string, number>();
  let cardIds = 0;
  for (const target of targets) {
    if (target.kind === 'field')
      counts.set(target.fieldKey, (counts.get(target.fieldKey) ?? 0) + 1);
    if (target.kind === 'card_id') cardIds += 1;
  }
  const front = frontFieldKey(noteType);
  const duplicateFields = [...counts]
    .filter(([key, n]) => n > 1 && key !== notesKey)
    .map(([key]) => key);
  return {
    ...(front && !counts.has(front) ? { missingFront: front } : {}),
    duplicateFields,
    duplicateCardId: cardIds > 1,
  };
}

export function hasMappingProblems(problems: MappingProblems): boolean {
  return (
    problems.missingFront !== undefined ||
    problems.duplicateFields.length > 0 ||
    problems.duplicateCardId
  );
}
