import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DictionaryBrowseQuery, DictionaryEntry } from '@flash/core/dictionary';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { WebDictionaryService } from '../src/dictionary/web-dictionary-service.ts';
import { DexiePackStorage } from '../src/packs/dexie-pack-storage.ts';
import { WebPackManager } from '../src/packs/web-pack-manager.ts';

const PACKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'apps',
  'web',
  'public',
  'packs',
);

async function installStarters(slug: string): Promise<{
  storage: DexiePackStorage;
  svc: WebDictionaryService;
}> {
  const storage = new DexiePackStorage(slug);
  const manager = new WebPackManager({
    packStorage: storage,
    defaultCatalogUrl: 'https://packs.example.com/packs.json',
    fetchImpl: () => Promise.reject(new Error('offline')),
  });
  for (const file of [
    'dict-krdict.json.gz',
    'dict-hanja-unihan.json.gz',
    'dict-kanjidic2.json.gz',
  ]) {
    await manager.installPackFromBytes(new Uint8Array(readFileSync(join(PACKS_DIR, file))));
  }
  return { storage, svc: new WebDictionaryService(storage) };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

async function browseAll(
  svc: WebDictionaryService,
  query: DictionaryBrowseQuery,
): Promise<DictionaryEntry[]> {
  const out: DictionaryEntry[] = [];
  let after: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await svc.browse({ ...query, ...(after ? { after } : {}) });
    out.push(...page.entries);
    if (!page.next) break;
    after = page.next;
  }
  return out;
}

describe('dictionary browse over installed starter packs (IndexedDB)', () => {
  it('lists levels, topics and grades in order, with 초성 jumps, POS filters and paging', async () => {
    const { storage, svc } = await installStarters(`test-browse-${Date.now()}`);

    const summary = await svc.getBrowseSummary('dict-krdict');
    expect(summary.total).toBe(58);
    expect(summary.levels.map((l) => l.key)).toEqual(['beginner', 'intermediate', 'advanced']);
    expect(summary.topics.find((t) => t.key === '학교생활')?.count).toBe(9);
    expect(summary.topics.map((t) => t.key)).toContain('식생활');
    expect(summary.pos.map((p) => p.key)).toEqual(expect.arrayContaining(['noun', 'verb']));
    // Cached: the second call returns the same summary.
    expect(await svc.getBrowseSummary('dict-krdict')).toEqual(summary);

    const beginner: DictionaryBrowseQuery = {
      packId: 'dict-krdict',
      facet: { kind: 'level', level: 'beginner' },
    };
    const firstPage = await svc.browse(beginner);
    const beginnerCount = summary.levels[0]?.count ?? 0;
    expect(firstPage.entries).toHaveLength(Math.min(50, beginnerCount));
    expect(firstPage.entries.every((e) => e.level === 'beginner')).toBe(true);
    const headwords = firstPage.entries.map((e) => e.headword);
    expect(headwords).toEqual([...headwords].sort(cmp));

    // Small pages walk the whole group exactly once.
    const paged = await browseAll(svc, { ...beginner, limit: 7 });
    expect(paged).toHaveLength(beginnerCount);
    expect(new Set(paged.map((e) => e.id)).size).toBe(beginnerCount);

    const hieut = await svc.browse({ ...beginner, initial: 'ㅎ' });
    expect(hieut.entries.map((e) => e.headword)).toEqual(
      expect.arrayContaining(['학교', '학생', '한국', '한국어', '하다']),
    );
    expect(hieut.entries.every((e) => e.headword >= '하')).toBe(true);

    const verbs = await browseAll(svc, { ...beginner, pos: 'verb', limit: 5 });
    expect(verbs.length).toBeGreaterThan(5);
    expect(verbs.every((e) => e.pos?.includes('verb'))).toBe(true);

    const school = await svc.browse({
      packId: 'dict-krdict',
      facet: { kind: 'topic', topic: '학교생활' },
    });
    expect(school.entries.map((e) => e.headword)).toContain('도서관');

    const advanced = await svc.browse({
      packId: 'dict-krdict',
      facet: { kind: 'level', level: 'advanced' },
    });
    expect(advanced.entries.map((e) => e.headword)).toEqual(['꾸준하다', '정책']);

    // Grades: Hanja education grades; KANJIDIC2 `Grade 1 · JLPT N5` splits into two groups.
    const hanja = await svc.getBrowseSummary('dict-hanja-unihan');
    expect(hanja.grades.map((g) => g.key)).toContain('Education Hanja (Basic)');
    const kanji = await svc.getBrowseSummary('dict-kanjidic2');
    expect(kanji.grades.map((g) => g.key)).toEqual(expect.arrayContaining(['Grade 1', 'JLPT N5']));
    const n5 = await svc.browse({
      packId: 'dict-kanjidic2',
      facet: { kind: 'grade', grade: 'JLPT N5' },
    });
    expect(n5.entries.length).toBeGreaterThan(0);
    expect(n5.entries.every((e) => e.grade?.includes('JLPT N5'))).toBe(true);
    storage.close();
  });

  it('English → Korean never reads an English word as romanization', async () => {
    const { storage, svc } = await installStarters(`test-direction-${Date.now()}`);
    expect((await svc.search('hanguk'))[0]?.headword).toBe('한국');
    const fromEnglish = await svc.search('hanguk', {
      packIds: ['dict-krdict'],
      direction: 'from-english',
    });
    expect(fromEnglish.map((e) => e.headword)).not.toContain('한국');
    expect(
      (await svc.search('school', { packIds: ['dict-krdict'], direction: 'from-english' }))[0]
        ?.headword,
    ).toBe('학교');
    storage.close();
  });

  it('a Hanja lookup lists the Korean words written with it', async () => {
    const { storage, svc } = await installStarters(`test-hanja-words-${Date.now()}`);
    const found = await svc.lookupCharacter('學');
    expect(found[0]?.headword).toBe('學');
    expect(found.map((e) => e.headword)).toEqual(expect.arrayContaining(['학교', '학생']));
    storage.close();
  });

  it('adds browse keys to entries stored by the v1 schema', async () => {
    const slug = `test-browse-upgrade-${Date.now()}`;
    const v1 = new Dexie(`flashcards-packs-db-${slug}`);
    v1.version(1).stores({
      packs: 'id, kind, language',
      dict_entries: 'id, packId, headword, *altForms, *searchTokens',
      strokes: '[script+char], script, packId',
      stroke_index: 'id',
      kv: 'key',
    });
    const row: DictionaryEntry = {
      id: 'dict-krdict:0:학교',
      packId: 'dict-krdict',
      headword: '학교',
      readings: ['학꾜'],
      meanings: ['school'],
      level: 'beginner',
      searchTokens: ['학교'],
    };
    await v1.table('dict_entries').put(row);
    v1.close();

    const storage = new DexiePackStorage(slug);
    const page = await storage.browseDictionary({
      packId: 'dict-krdict',
      facet: { kind: 'level', level: 'beginner' },
    });
    expect(page.entries.map((e) => e.headword)).toEqual(['학교']);
    storage.close();
  });
});
