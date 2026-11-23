import { CHOSEONG_JAMO } from './korean.ts';
import type {
  DictionaryBrowseCount,
  DictionaryBrowseFacet,
  DictionaryBrowseQuery,
  DictionaryBrowseSummary,
  DictionaryEntry,
  DictionaryLevel,
  DictionaryPackId,
} from './types.ts';

/**
 * Browsing a dictionary without typing (by learner level, topic, grade, or the whole pack in
 * 가나다 order). Every entry gets one browse key per group it belongs to:
 *
 *   `${packId}␁${facet}␁${headword}␁${id}`
 *
 * Stored in a multiEntry index, a key range on one prefix lists that group in headword order,
 * a narrower range on the headword jumps to a 초성 (`ㅎ` → `하`…`힣`), and the full key of the
 * last row is the cursor for the next page. Keys compare by UTF-16 code unit, which is 가나다
 * order for Hangul syllables.
 */
const SEP = '\u0001';
/** Above every character a headword or id can contain, so `prefix + END` closes a range. */
const END = '￿';

const MAX_TOPICS_PER_ENTRY = 8;

export const DICTIONARY_LEVELS: readonly DictionaryLevel[] = [
  'beginner',
  'intermediate',
  'advanced',
];

/** The 14 basic consonants of a 가나다 jump bar; each also covers its tense pair (ㄱ → ㄱ, ㄲ). */
export const CHOSEONG_JUMP_JAMO: readonly string[] = [...'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ'];

const SYLLABLES_PER_INITIAL = 21 * 28;
const S_BASE = 0xac00;

/**
 * Hangul syllable range `[from, to)` for words starting with initial consonant `jamo`.
 * A basic consonant includes its tense pair, which follows it in Unicode (ㄱ: 가 … 낗).
 */
export function choseongSyllableRange(jamo: string): [string, string] | undefined {
  const idx = CHOSEONG_JAMO.indexOf(jamo);
  if (idx < 0 || jamo.length !== 1) return undefined;
  const next = CHOSEONG_JAMO[idx + 1];
  const span = next !== undefined && 'ㄲㄸㅃㅆㅉ'.includes(next) ? 2 : 1;
  const from = String.fromCodePoint(S_BASE + idx * SYLLABLES_PER_INITIAL);
  const to = String.fromCodePoint(S_BASE + (idx + span) * SYLLABLES_PER_INITIAL);
  return [from, to];
}

/** Grades written as `Grade 1 · JLPT N5` are two groups. */
export function splitDictionaryGrade(grade: string | undefined): string[] {
  if (!grade) return [];
  return grade
    .split('·')
    .map((g) => g.trim())
    .filter(Boolean);
}

function facetKey(facet: DictionaryBrowseFacet): string {
  switch (facet.kind) {
    case 'all':
      return 'all';
    case 'level':
      return `level:${facet.level}`;
    case 'topic':
      return `topic:${facet.topic}`;
    case 'grade':
      return `grade:${facet.grade}`;
  }
}

function facetPrefix(packId: DictionaryPackId, facet: DictionaryBrowseFacet): string {
  return `${packId}${SEP}${facetKey(facet)}${SEP}`;
}

/** Every group `entry` belongs to (always including `all`). */
export function entryBrowseFacets(
  entry: Pick<DictionaryEntry, 'level' | 'topics' | 'grade'>,
): DictionaryBrowseFacet[] {
  const facets: DictionaryBrowseFacet[] = [{ kind: 'all' }];
  if (entry.level) facets.push({ kind: 'level', level: entry.level });
  for (const topic of new Set((entry.topics ?? []).slice(0, MAX_TOPICS_PER_ENTRY))) {
    facets.push({ kind: 'topic', topic });
  }
  for (const grade of new Set(splitDictionaryGrade(entry.grade))) {
    facets.push({ kind: 'grade', grade });
  }
  return facets;
}

/** Browse-index keys for one stored entry. */
export function buildEntryBrowseKeys(
  entry: Pick<DictionaryEntry, 'id' | 'packId' | 'headword' | 'level' | 'topics' | 'grade'>,
): string[] {
  const tail = `${entry.headword.normalize('NFC')}${SEP}${entry.id}`;
  return entryBrowseFacets(entry).map((f) => `${facetPrefix(entry.packId, f)}${tail}`);
}

export interface DictionaryBrowseRange {
  /** Inclusive lower key (exclusive when `lowerOpen`). */
  lower: string;
  lowerOpen: boolean;
  /** Exclusive upper key. */
  upper: string;
}

/**
 * The browse-index key range for one page of `query`. `undefined` when the range is empty
 * (an unknown 초성, or a cursor past the end).
 */
export function browseKeyRange(query: DictionaryBrowseQuery): DictionaryBrowseRange | undefined {
  const prefix = facetPrefix(query.packId, query.facet);
  let lower = prefix;
  let upper = prefix + END;
  if (query.initial) {
    const range = choseongSyllableRange(query.initial);
    if (!range) return undefined;
    lower = prefix + range[0];
    upper = prefix + range[1];
  }
  const after = query.after;
  if (after !== undefined) {
    if (!after.startsWith(prefix) || after >= upper) return undefined;
    if (after >= lower) return { lower: after, lowerOpen: true, upper };
  }
  return { lower, lowerOpen: false, upper };
}

/** The browse key of `entry` inside `query`'s group: the cursor after that entry. */
export function browseCursorFor(query: DictionaryBrowseQuery, entry: DictionaryEntry): string {
  return `${facetPrefix(query.packId, query.facet)}${entry.headword.normalize('NFC')}${SEP}${entry.id}`;
}

/** True when `entry` passes the query's in-memory filters (part of speech). */
export function matchesBrowseFilters(
  query: DictionaryBrowseQuery,
  entry: DictionaryEntry,
): boolean {
  return !query.pos || (entry.pos?.includes(query.pos) ?? false);
}

export const DEFAULT_BROWSE_PAGE_SIZE = 50;
export const MAX_BROWSE_PAGE_SIZE = 200;

export function browsePageSize(query: DictionaryBrowseQuery): number {
  return Math.max(1, Math.min(MAX_BROWSE_PAGE_SIZE, query.limit ?? DEFAULT_BROWSE_PAGE_SIZE));
}

/** Code-unit order so summaries are identical on every machine and locale. */
function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function sortedCounts(map: Map<string, number>, order: 'count' | 'key'): DictionaryBrowseCount[] {
  const rows = [...map].map(([key, count]) => ({ key, count }));
  return rows.sort((a, b) =>
    order === 'count' ? b.count - a.count || compareKeys(a.key, b.key) : compareKeys(a.key, b.key),
  );
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Streams entries into a pack's browse summary (installs can feed it without holding every row). */
export class DictionaryBrowseSummaryBuilder {
  private total = 0;
  private readonly levels = new Map<string, number>();
  private readonly topics = new Map<string, number>();
  private readonly grades = new Map<string, number>();
  private readonly pos = new Map<string, number>();

  private readonly packId: DictionaryPackId;

  constructor(packId: DictionaryPackId) {
    this.packId = packId;
  }

  add(entry: Pick<DictionaryEntry, 'level' | 'topics' | 'grade' | 'pos'>): void {
    this.total++;
    if (entry.level) bump(this.levels, entry.level);
    for (const topic of new Set((entry.topics ?? []).slice(0, MAX_TOPICS_PER_ENTRY))) {
      bump(this.topics, topic);
    }
    for (const grade of new Set(splitDictionaryGrade(entry.grade))) bump(this.grades, grade);
    for (const p of new Set(entry.pos ?? [])) bump(this.pos, p);
  }

  build(): DictionaryBrowseSummary {
    const levels = DICTIONARY_LEVELS.filter((l) => this.levels.has(l)).map((l) => ({
      key: l,
      count: this.levels.get(l) ?? 0,
    }));
    return {
      packId: this.packId,
      total: this.total,
      levels,
      topics: sortedCounts(this.topics, 'count'),
      grades: sortedCounts(this.grades, 'key'),
      pos: sortedCounts(this.pos, 'count'),
    };
  }
}

export function summarizeDictionaryBrowse(
  packId: DictionaryPackId,
  entries: Iterable<Pick<DictionaryEntry, 'level' | 'topics' | 'grade' | 'pos'>>,
): DictionaryBrowseSummary {
  const builder = new DictionaryBrowseSummaryBuilder(packId);
  for (const e of entries) builder.add(e);
  return builder.build();
}
