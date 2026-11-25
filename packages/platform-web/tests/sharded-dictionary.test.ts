import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  buildShardedDictionaryPack,
  findShardForHeadword,
  type DictionaryEntry,
  type EncodedPackFile,
  type RawDictionaryEntry,
} from '@flash/core/dictionary';
import { describe, expect, it } from 'vitest';
import { WebDictionaryService } from '../src/dictionary/web-dictionary-service.ts';
import { DexiePackStorage } from '../src/packs/dexie-pack-storage.ts';
import { WebPackManager } from '../src/packs/web-pack-manager.ts';

const BASE = 'https://packs.example.com/packs';
const INDEX_URL = `${BASE}/dict-krdict.json.gz`;

const MANIFEST = {
  format_version: 1,
  id: 'dict-krdict',
  kind: 'dictionary',
  name: 'KRDict (sharded test)',
  version: 'test-1',
  language: 'ko',
  description: 'Synthetic multi-shard pack',
  license_name: 'CC BY-SA 2.0 KR',
  license_url: 'https://creativecommons.org/licenses/by-sa/2.0/kr/',
  attribution: 'Test',
  source_url: 'https://krdict.korean.go.kr/',
};

function word(
  headword: string,
  equivalents: string[][],
  extra: Partial<RawDictionaryEntry> = {},
): RawDictionaryEntry {
  return {
    headword,
    readings: [headword],
    meanings: equivalents.map((e) => e.join('; ')),
    pos: ['noun'],
    level: 'beginner',
    senses: equivalents.map((eq, i) => ({
      equivalents: eq,
      definition: `Definition ${i + 1} of ${headword}, long enough to weigh something in a shard.`,
      examples: [
        { text: `${headword}을/를 예문에서 씁니다. 첫 번째 예문입니다.`, type: 'sentence' },
        { text: `${headword} 두 번째 예문은 조금 더 깁니다. 정말로 그렇습니다.` },
      ],
      source: 'krdict',
    })),
    topics: ['일상'],
    ...extra,
  };
}

const ENTRIES: RawDictionaryEntry[] = [
  word('학교', [['school']], { altForms: ['學校'], origin: '學校' }),
  word('가다', [['go']], { pos: ['verb'] }),
  word('먹다', [['eat'], ['take']], { pos: ['verb'], forms: ['먹어'] }),
  word('CD', [['compact disc']]),
  word('까치', [['magpie']]),
  word('나무', [['tree']]),
  word('한국', [['Korea']], { altForms: ['韓國'], origin: '韓國' }),
  word('다리', [['leg'], ['bridge']]),
  word('물', [['water']], { level: 'intermediate' }),
  word('바다', [['sea']]),
  word('사다', [['buy']], { pos: ['verb'] }),
  word('아들', [['son']]),
  word('자다', [['sleep']], { pos: ['verb'] }),
  word('책', [['book']]),
  word('한국어', [['Korean', 'Korean language']], { altForms: ['韓國語'] }),
  word('고양이', [['cat']]),
];

/** Encodes like `scripts/build-packs.mjs` (node zlib level 9, SHA-256 of the raw JSON). */
function encode(payload: unknown): EncodedPackFile {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const bytes = new Uint8Array(gzipSync(raw, { level: 9 }));
  return {
    bytes,
    compressed_bytes: bytes.byteLength,
    uncompressed_bytes: raw.byteLength,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

// A lowered shard limit forces several shards out of a few entries.
const PACK = buildShardedDictionaryPack({
  manifest: MANIFEST,
  entries: ENTRIES,
  indexFile: 'dict-krdict.json.gz',
  maxShardBytes: 700,
  encode,
});
const UNSHARDED = encode({ manifest: MANIFEST, entries: ENTRIES });

function serve(files: Map<string, Uint8Array>) {
  const requested: string[] = [];
  let offline = false;
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url.slice(BASE.length + 1));
    if (offline) return Promise.reject(new TypeError('Failed to fetch'));
    const body = files.get(url);
    return Promise.resolve(
      body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 }),
    );
  }) as typeof fetch;
  return {
    fetchImpl,
    requested,
    setOffline: (v: boolean) => {
      offline = v;
    },
  };
}

function packFiles(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([[INDEX_URL, PACK.index.encoded.bytes]]);
  for (const s of PACK.shards) files.set(`${BASE}/${s.descriptor.file}`, s.encoded.bytes);
  return files;
}

let dbCounter = 0;
async function setup(files = packFiles()) {
  const storage = new DexiePackStorage(`test-sharded-${Date.now()}-${dbCounter++}`);
  const net = serve(files);
  const manager = new WebPackManager({ packStorage: storage, fetchImpl: net.fetchImpl });
  const svc = new WebDictionaryService(storage, { fetchImpl: net.fetchImpl });
  const info = await manager.installPackFromUrl(INDEX_URL, {
    expectedSha256: PACK.index.encoded.sha256,
  });
  net.requested.length = 0;
  return { storage, manager, svc, info, ...net };
}

const shardFile = (headword: string) =>
  findShardForHeadword(PACK.sharding, headword)?.file ?? 'none';
const hasExamples = (e: DictionaryEntry | undefined) =>
  Boolean(e?.senses?.[0]?.examples && e.senses[0].examples.length > 0);

describe('sharded dictionary packs (IndexedDB, lazy shards)', () => {
  it('installs only the index: every row is a searchable stub', async () => {
    expect(PACK.shards.length).toBeGreaterThanOrEqual(4);
    const { info, storage } = await setup();
    expect(info).toMatchObject({ entryCount: ENTRIES.length, shardCount: PACK.shards.length });
    expect(info.shardsLoaded).toBe(0);
    expect(info.byteSize).toBe(PACK.index.encoded.compressed_bytes);
    const rows = await storage.lookupDictionaryByHeadword('먹다');
    expect(rows[0]?.stub).toBe(true);
    expect(hasExamples(rows[0])).toBe(false);
    expect(rows[0]?.senses?.map((s) => s.equivalents)).toEqual([['eat'], ['take']]);
  });

  it("routes a Korean query to its first syllable's shard and returns full entries", async () => {
    const { svc, requested } = await setup();
    const [top] = await svc.search('먹어');
    expect(top?.headword).toBe('먹다');
    expect(top?.stub).toBeUndefined();
    expect(hasExamples(top)).toBe(true);
    expect(requested).toEqual([shardFile('먹다')]);
    // Once loaded, the shard is not fetched again.
    await svc.search('먹다');
    expect(requested).toEqual([shardFile('먹다')]);
  });

  it('finds words across shards: English, 초성, jamo, romanization and Hanja', async () => {
    const { svc, requested } = await setup();
    const top = async (q: string, direction?: 'from-english') =>
      (await svc.search(q, direction ? { direction } : {}))[0];

    const school = await top('school', 'from-english');
    expect(school?.headword).toBe('학교');
    expect(hasExamples(school)).toBe(true);
    expect((await top('sleep', 'from-english'))?.headword).toBe('자다');

    const choseong = (await svc.search('ㅎㄱ')).map((e) => e.headword);
    expect(choseong.slice(0, 2).sort()).toEqual(['학교', '한국']);
    expect((await top('하'))?.headword).toMatch(/^한|^학/);
    expect((await top('gada'))?.headword).toBe('가다');
    expect((await top('韓國'))?.headword).toBe('한국');
    expect((await top('CD'))?.headword).toBe('CD');
    // Each lookup fetched only the shards of its own results.
    expect(new Set(requested)).toEqual(new Set(['학교', '자다', '가다', 'CD'].map(shardFile)));
  });

  it('browses the whole pack from the index, completing at most 3 shards per page', async () => {
    const { svc, storage, requested } = await setup();
    const page = await svc.browse({ packId: 'dict-krdict', facet: { kind: 'all' }, limit: 100 });
    expect(page.entries).toHaveLength(ENTRIES.length);
    expect(new Set(requested).size).toBeLessThanOrEqual(3);
    expect(page.entries.some((e) => e.stub)).toBe(true);
    expect(page.entries.slice(0, 3).every((e) => !e.stub)).toBe(true);
    // Browse groups and counts come from the stubs, so they match the full pack.
    const summary = await storage.getBrowseSummary('dict-krdict');
    expect(summary.total).toBe(ENTRIES.length);
    expect(summary.levels).toEqual([
      { key: 'beginner', count: ENTRIES.length - 1 },
      { key: 'intermediate', count: 1 },
    ]);
    // loadFullEntries completes the rest (Add to Deck, the detail pane).
    const full = await svc.loadFullEntries(page.entries);
    expect(full.every((e) => !e.stub && hasExamples(e))).toBe(true);
    expect(full.map((e) => e.id)).toEqual(page.entries.map((e) => e.id));
  });

  it('ends up identical to the unsharded pack once every shard is downloaded', async () => {
    const { manager, svc, storage } = await setup();
    const info = await manager.downloadAllShards('dict-krdict');
    expect(info.shardsLoaded).toBe(PACK.shards.length);
    const shardBytes = PACK.shards.reduce((n, s) => n + s.encoded.compressed_bytes, 0);
    expect(info.byteSize).toBe(PACK.index.encoded.compressed_bytes + shardBytes);

    const plain = new DexiePackStorage(`test-unsharded-${Date.now()}`);
    await new WebPackManager({ packStorage: plain }).installPackFromBytes(UNSHARDED.bytes);
    const all = async (s: DexiePackStorage) =>
      (await s.browseDictionary({ packId: 'dict-krdict', facet: { kind: 'all' }, limit: 100 }))
        .entries;
    expect(await all(storage)).toEqual(await all(plain));
    expect(await plain.getShardState('dict-krdict')).toBeUndefined();
    expect((await svc.search('eat'))[0]?.id).toBe(
      (await new WebDictionaryService(plain).search('eat'))[0]?.id,
    );
  });

  it('keeps working offline with stubs, and refuses a tampered shard', async () => {
    const offline = await setup();
    offline.setOffline(true);
    const [top] = await offline.svc.search('먹다');
    expect(top?.headword).toBe('먹다');
    expect(top?.stub).toBe(true);
    expect((await offline.storage.getShardState('dict-krdict'))?.loaded).toEqual([]);

    const files = packFiles();
    files.set(`${BASE}/${shardFile('먹다')}`, PACK.shards[0]?.encoded.bytes ?? new Uint8Array());
    const tampered = await setup(files);
    const [stub] = await tampered.svc.search('먹다');
    expect(stub?.stub).toBe(true);
    expect((await tampered.storage.getShardState('dict-krdict'))?.loaded).toEqual([]);
  });

  it('needs the index URL, and an unsharded reinstall drops the shard state', async () => {
    const { manager, storage } = await setup();
    await expect(manager.installPackFromBytes(PACK.index.encoded.bytes)).rejects.toThrow(
      /sharded pack/,
    );
    const info = await manager.installPackFromBytes(UNSHARDED.bytes);
    expect(info.shardCount).toBeUndefined();
    expect(await storage.getShardState('dict-krdict')).toBeUndefined();
    const [row] = await storage.lookupDictionaryByHeadword('먹다');
    expect(row?.stub).toBeUndefined();
    expect(hasExamples(row)).toBe(true);
  });

  it('loads the unsharded starter KRDict pack exactly as before', async () => {
    const packsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'apps',
      'web',
      'public',
      'packs',
    );
    const storage = new DexiePackStorage(`test-starter-${Date.now()}`);
    const manager = new WebPackManager({ packStorage: storage });
    const info = await manager.installPackFromBytes(
      new Uint8Array(readFileSync(join(packsDir, 'dict-krdict.json.gz'))),
    );
    expect(info.shardCount).toBeUndefined();
    expect(await storage.getShardState('dict-krdict')).toBeUndefined();
    const [row] = await new WebDictionaryService(storage).search('먹었어요');
    expect(row?.headword).toBe('먹다');
    expect(row?.stub).toBeUndefined();
  });
});
