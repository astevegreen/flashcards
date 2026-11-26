import fc from 'fast-check';
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  browseCursorFor,
  browseKeyRange,
  buildEntryBrowseKeys,
  CHOSEONG_JUMP_JAMO,
  choseongSyllableRange,
  decodePackArchive,
  DictionaryBrowseSummaryBuilder,
  entryBrowseFacets,
  materializeDictionaryEntries,
  planDictionarySearch,
  rankDictionaryResults,
  splitDictionaryGrade,
  toChoseong,
  type DictionaryBrowseQuery,
  type DictionaryEntry,
} from '../src/dictionary/index.ts';

type RawEntry = Omit<DictionaryEntry, 'id' | 'packId' | 'searchTokens'>;

const word = (headword: string, extra: Partial<RawEntry> = {}): RawEntry => ({
  headword,
  readings: [headword],
  meanings: ['x'],
  ...extra,
});

/** The keys of `entries` that fall inside `query`'s range, the way IndexedDB would list them. */
function listInRange(entries: readonly DictionaryEntry[], query: DictionaryBrowseQuery): string[] {
  const range = browseKeyRange(query);
  if (!range) return [];
  const keys = entries.flatMap((e) => e.browseKeys ?? []);
  return keys
    .filter((k) => (range.lowerOpen ? k > range.lower : k >= range.lower) && k < range.upper)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const headwordOf = (key: string): string => key.split('\u0001')[2] ?? '';

describe('choseongSyllableRange', () => {
  it('covers a basic consonant and its tense pair', () => {
    expect(choseongSyllableRange('ㄱ')).toEqual(['가', '나']);
    expect(choseongSyllableRange('ㅎ')).toEqual(['하', String.fromCharCode(0xd7a4)]);
    expect(choseongSyllableRange('ㅅ')).toEqual(['사', '아']);
    expect(choseongSyllableRange('ㄲ')).toEqual(['까', '나']);
    expect(choseongSyllableRange('ㄴ')).toEqual(['나', '다']);
    expect(choseongSyllableRange('a')).toBeUndefined();
    expect(choseongSyllableRange('ㄱㄴ')).toBeUndefined();
  });

  it('puts every Hangul syllable under exactly one jump-bar consonant', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0xac00, max: 0xd7a3 }), (cp) => {
        const ch = String.fromCharCode(cp);
        const hits = CHOSEONG_JUMP_JAMO.filter((j) => {
          const r = choseongSyllableRange(j);
          return r !== undefined && ch >= r[0] && ch < r[1];
        });
        expect(hits).toHaveLength(1);
        // …and it is that syllable's own initial, or its plain (untensed) form.
        const initial = toChoseong(ch);
        expect([initial, { ㄲ: 'ㄱ', ㄸ: 'ㄷ', ㅃ: 'ㅂ', ㅆ: 'ㅅ', ㅉ: 'ㅈ' }[initial]]).toContain(
          hits[0],
        );
      }),
    );
  });
});

describe('browse keys and ranges', () => {
  const entries = materializeDictionaryEntries('dict-krdict', [
    word('학교', { level: 'beginner', pos: ['noun'], topics: ['학교생활', '교육'] }),
    word('한국', { level: 'beginner', pos: ['noun'] }),
    word('가다', { level: 'beginner', pos: ['verb'] }),
    word('꿈', { level: 'intermediate', pos: ['noun'] }),
    word('정책', { level: 'advanced', pos: ['noun'] }),
    word('사다', { level: 'beginner', pos: ['verb'], topics: ['물건 사기'] }),
    word('나무'),
  ]);

  it('gives every entry an `all` key plus one per level, topic and grade', () => {
    expect(entryBrowseFacets({ level: 'beginner', topics: ['a', 'a', 'b'] })).toEqual([
      { kind: 'all' },
      { kind: 'level', level: 'beginner' },
      { kind: 'topic', topic: 'a' },
      { kind: 'topic', topic: 'b' },
    ]);
    expect(entryBrowseFacets({ grade: 'Grade 1 · JLPT N5' })).toEqual([
      { kind: 'all' },
      { kind: 'grade', grade: 'Grade 1' },
      { kind: 'grade', grade: 'JLPT N5' },
    ]);
    expect(entries.every((e) => e.browseKeys?.length)).toBe(true);
    expect(buildEntryBrowseKeys(entries[0] as DictionaryEntry)).toEqual(entries[0]?.browseKeys);
  });

  it('lists a group in 가나다 order and jumps by 초성', () => {
    const all: DictionaryBrowseQuery = { packId: 'dict-krdict', facet: { kind: 'all' } };
    expect(listInRange(entries, all).map(headwordOf)).toEqual([
      '가다',
      '꿈',
      '나무',
      '사다',
      '정책',
      '학교',
      '한국',
    ]);
    const beginner: DictionaryBrowseQuery = {
      packId: 'dict-krdict',
      facet: { kind: 'level', level: 'beginner' },
    };
    expect(listInRange(entries, beginner).map(headwordOf)).toEqual([
      '가다',
      '사다',
      '학교',
      '한국',
    ]);
    expect(listInRange(entries, { ...beginner, initial: 'ㅎ' }).map(headwordOf)).toEqual([
      '학교',
      '한국',
    ]);
    // ㄱ includes ㄲ words.
    expect(listInRange(entries, { ...all, initial: 'ㄱ' }).map(headwordOf)).toEqual(['가다', '꿈']);
    expect(
      listInRange(entries, {
        packId: 'dict-krdict',
        facet: { kind: 'topic', topic: '학교생활' },
      }).map(headwordOf),
    ).toEqual(['학교']);
    // Groups never leak into each other or into other packs.
    expect(listInRange(entries, { packId: 'dict-jmdict', facet: { kind: 'all' } })).toEqual([]);
    expect(browseKeyRange({ ...all, initial: 'x' })).toBeUndefined();
  });

  it('pages with a cursor without skipping or repeating entries', () => {
    const all: DictionaryBrowseQuery = { packId: 'dict-krdict', facet: { kind: 'all' } };
    const sorted = [...entries].sort((a, b) =>
      a.headword < b.headword ? -1 : a.headword > b.headword ? 1 : 0,
    );
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const keys = listInRange(entries, { ...all, ...(after ? { after } : {}) }).slice(0, 2);
      if (keys.length === 0) break;
      seen.push(...keys.map(headwordOf));
      const lastHeadword = headwordOf(keys.at(-1) ?? '');
      const last = sorted.find((e) => e.headword === lastHeadword) as DictionaryEntry;
      after = browseCursorFor(all, last);
    }
    expect(seen).toEqual(sorted.map((e) => e.headword));
    // A cursor from another group is ignored rather than trusted.
    expect(browseKeyRange({ ...all, after: 'dict-jmdict\u0001all\u0001x' })).toBeUndefined();
  });

  it('summarizes levels (in order), topics (by count), grades and parts of speech', () => {
    const builder = new DictionaryBrowseSummaryBuilder('dict-krdict');
    for (const e of entries) builder.add(e);
    const summary = builder.build();
    expect(summary.total).toBe(7);
    expect(summary.levels).toEqual([
      { key: 'beginner', count: 4 },
      { key: 'intermediate', count: 1 },
      { key: 'advanced', count: 1 },
    ]);
    expect(summary.topics.map((t) => t.key)).toEqual(['교육', '물건 사기', '학교생활']);
    expect(summary.pos).toEqual([
      { key: 'noun', count: 4 },
      { key: 'verb', count: 2 },
    ]);
    expect(splitDictionaryGrade('Grade 1 · JLPT N5')).toEqual(['Grade 1', 'JLPT N5']);
    expect(splitDictionaryGrade(undefined)).toEqual([]);
  });
});

describe('lookup direction', () => {
  const entries = materializeDictionaryEntries('dict-krdict', [
    word('손', { meanings: ['hand'], senses: [{ equivalents: ['hand'] }] }),
    word('한국', { meanings: ['Korea'], senses: [{ equivalents: ['Korea'] }] }),
  ]);

  it('reads Latin letters as romanization only when looking up into English', () => {
    expect(planDictionarySearch('hanguk').headwordCandidates).toContain('한국');
    expect(planDictionarySearch('hanguk', 'from-english').headwordCandidates).toEqual([]);
    expect(rankDictionaryResults(entries, 'son')[0]?.headword).toBe('손');
    expect(rankDictionaryResults(entries, 'son', { direction: 'from-english' })).toEqual([]);
    expect(rankDictionaryResults(entries, 'hand', { direction: 'from-english' })[0]?.headword).toBe(
      '손',
    );
  });
});

describe('pack codec topics', () => {
  it('decodes, deduplicates and caps topics', () => {
    const payload = {
      manifest: {
        format_version: 1,
        id: 'dict-krdict',
        kind: 'dictionary',
        name: 'KRDict',
        version: '1',
        language: 'ko',
        description: 'd',
        license_name: 'CC BY-SA 2.0 KR',
        license_url: 'https://creativecommons.org/licenses/by-sa/2.0/kr/',
        attribution: 'a',
        source_url: 'https://krdict.korean.go.kr/',
      },
      entries: [
        {
          headword: '학교',
          readings: ['학꾜'],
          meanings: ['school'],
          topics: ['학교생활', '학교생활', 3, '', ...Array.from({ length: 20 }, (_, i) => `t${i}`)],
        },
        { headword: '물', readings: ['물'], meanings: ['water'], topics: 'not-a-list' },
      ],
    };
    const bytes = gzipSync(new TextEncoder().encode(JSON.stringify(payload)));
    const decoded = decodePackArchive(bytes);
    if (!('entries' in decoded)) throw new Error('expected a dictionary pack');
    expect(decoded.entries[0]?.topics?.[0]).toBe('학교생활');
    expect(decoded.entries[0]?.topics?.length).toBeLessThanOrEqual(8);
    expect(new Set(decoded.entries[0]?.topics).size).toBe(decoded.entries[0]?.topics?.length);
    expect(decoded.entries[1]?.topics).toBeUndefined();
  });
});
