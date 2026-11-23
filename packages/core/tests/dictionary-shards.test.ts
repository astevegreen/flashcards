import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildEntrySearchTokens,
  buildShardedDictionaryPack,
  decodeDictionaryShard,
  decodePackArchive,
  findShardForHeadword,
  materializeDictionaryEntries,
  parseAndValidatePackCatalog,
  planDictionaryShards,
  rankDictionaryResults,
  toDictionaryStubEntry,
  type DictionaryPackPayload,
  type EncodedPackFile,
  type RawDictionaryEntry,
} from '../src/dictionary/index.ts';
import { sha256Hex } from '../src/sources/hash.ts';

const MANIFEST = {
  format_version: 1 as const,
  id: 'dict-krdict' as const,
  kind: 'dictionary' as const,
  name: 'KRDict test',
  version: 'test-1',
  language: 'ko',
  description: 'Synthetic sharding fixture',
  license_name: 'CC BY-SA 2.0 KR',
  license_url: 'https://creativecommons.org/licenses/by-sa/2.0/kr/',
  attribution: 'Test',
  source_url: 'https://krdict.korean.go.kr/',
};

/** A full KRDict-style entry: equivalents plus the heavy fields a stub leaves out. */
function word(headword: string, equivalents: string[][], extra: Partial<RawDictionaryEntry> = {}) {
  return {
    headword,
    readings: [headword],
    meanings: equivalents.map((e) => e.join('; ')),
    pos: ['noun'],
    level: 'beginner' as const,
    senses: equivalents.map((eq, i) => ({
      equivalents: eq,
      definition: `Definition ${i + 1} of ${headword}, long enough to weigh something in a shard.`,
      definitionNative: `${headword}의 ${i + 1}번째 뜻풀이입니다. 예문과 함께 쓰입니다.`,
      examples: [
        {
          text: `${headword}을/를 예문에서 씁니다. 첫 번째 예문입니다.`,
          type: 'sentence' as const,
        },
        { text: `${headword} 두 번째 예문은 조금 더 깁니다. 정말로 그렇습니다.` },
      ],
      relations: [{ type: 'related' as const, word: `${headword}관련어` }],
      source: 'krdict' as const,
    })),
    topics: ['일상'],
    ...extra,
  } satisfies RawDictionaryEntry;
}

const ENTRIES: RawDictionaryEntry[] = [
  word('학교', [['school']], { altForms: ['學校'], origin: '學校' }),
  word('가다', [['go']], { pos: ['verb'] }),
  word('먹다', [['eat'], ['take']], { pos: ['verb'], forms: ['먹어', '먹으니'] }),
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

function encode(payload: unknown): EncodedPackFile {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const bytes = gzipSync(raw, { level: 9 });
  return {
    bytes,
    compressed_bytes: bytes.byteLength,
    uncompressed_bytes: raw.byteLength,
    sha256: sha256Hex(raw),
  };
}

/** A shard limit that splits ENTRIES into several shards but fits every initial consonant. */
const MAX_SHARD_BYTES = 700;

function build(maxShardBytes = MAX_SHARD_BYTES) {
  return buildShardedDictionaryPack({
    manifest: MANIFEST,
    entries: ENTRIES,
    indexFile: 'dict-krdict.json.gz',
    maxShardBytes,
    encode,
  });
}

function decodeIndex(bytes: Uint8Array) {
  const decoded = decodePackArchive(bytes);
  if (!('entries' in decoded)) throw new Error('expected a dictionary pack');
  return decoded;
}

const cp = (s: string | undefined) => s?.codePointAt(0) ?? 0;

describe('first-syllable dictionary pack sharding (core)', () => {
  it('splits a pack over the shard limit into shards that each fit, plus a non-Hangul shard', () => {
    const pack = build();
    expect(pack.shards.length).toBeGreaterThan(3);
    for (const s of pack.shards)
      expect(s.encoded.compressed_bytes).toBeLessThanOrEqual(MAX_SHARD_BYTES);

    const rest = pack.shards.filter((s) => s.descriptor.from === undefined);
    expect(rest.map((s) => s.descriptor.key)).toEqual(['s00']);
    // Hangul shards are contiguous syllable ranges covering 가–힣, cut at 초성 boundaries.
    const ranges = pack.shards.filter((s) => s.descriptor.from !== undefined);
    expect(ranges[0]?.descriptor.from).toBe('가');
    expect(ranges.at(-1)?.descriptor.to).toBe('힣');
    ranges.forEach((s, i) => {
      expect((cp(s.descriptor.from) - 0xac00) % 588).toBe(0);
      if (i > 0) expect(cp(s.descriptor.from)).toBe(cp(ranges[i - 1]?.descriptor.to) + 1);
    });
    const counts = pack.shards.reduce((n, s) => n + s.descriptor.entry_count, 0);
    expect(counts).toBe(ENTRIES.length);
    expect(pack.sharding.total_entries).toBe(ENTRIES.length);
  });

  it('routes every headword to the shard holding it, by first syllable', () => {
    const { sharding } = build();
    const shardOf = (hw: string) => findShardForHeadword(sharding, hw);
    expect(shardOf('CD')?.key).toBe('s00');
    expect(shardOf('까치')).toBe(shardOf('가다')); // ㄱ shard covers ㄲ
    expect(shardOf('학교')).toBe(shardOf('한국어'));
    expect(shardOf('먹다')).not.toBe(shardOf('학교'));
    const range = shardOf('먹다');
    expect(cp(range?.from)).toBeLessThanOrEqual(cp('먹'));
    expect(cp(range?.to)).toBeGreaterThanOrEqual(cp('먹'));
  });

  it('decodes the index as format 2 with stub rows that search and rank like full rows', () => {
    const pack = build();
    const index = decodeIndex(pack.index.encoded.bytes);
    expect(index.manifest.format_version).toBe(2);
    expect(index.manifest.sharding?.shards.length).toBe(pack.shards.length);
    expect(index.entries.map((e) => e.headword)).toEqual(ENTRIES.map((e) => e.headword));

    const full = decodeIndex(encode({ manifest: MANIFEST, entries: ENTRIES }).bytes);
    index.entries.forEach((stub, i) => {
      const entry = full.entries[i];
      if (!entry) throw new Error('missing full entry');
      expect(stub.senses?.length).toBe(entry.senses?.length);
      expect(stub.senses?.some((s) => s.examples || s.definition || s.relations)).toBe(false);
      expect(buildEntrySearchTokens(stub).sort()).toEqual(buildEntrySearchTokens(entry).sort());
    });

    const stubRows = materializeDictionaryEntries('dict-krdict', index.entries, { stub: true });
    const fullRows = materializeDictionaryEntries('dict-krdict', full.entries);
    expect(stubRows.every((r) => r.stub)).toBe(true);
    expect(fullRows.some((r) => r.stub)).toBe(false);
    for (const q of ['먹어', 'eat', 'ㅎㄱ', '韓國', 'gada', 'school', '하']) {
      const ids = (rows: typeof stubRows) => rankDictionaryResults(rows, q).map((r) => r.id);
      expect(ids(stubRows)).toEqual(ids(fullRows));
    }
  });

  it('decodes each shard back to the full entries, with ids matching the stub rows', () => {
    const pack = build();
    const index = decodeIndex(pack.index.encoded.bytes);
    const sharding = index.manifest.sharding;
    if (!sharding) throw new Error('expected sharding');
    const full = decodeIndex(encode({ manifest: MANIFEST, entries: ENTRIES }).bytes);
    const fullIds = materializeDictionaryEntries('dict-krdict', full.entries).map((r) => r.id);
    const seen = new Set<string>();
    for (const s of pack.shards) {
      const shard = decodeDictionaryShard(s.encoded.bytes, {
        packId: 'dict-krdict',
        version: 'test-1',
        sharding,
        shard: s.descriptor,
      });
      shard.indices.forEach((idx, i) => expect(shard.entries[i]).toEqual(full.entries[idx]));
      const rows = materializeDictionaryEntries('dict-krdict', shard.entries, {
        indices: shard.indices,
      });
      for (const r of rows) seen.add(r.id);
    }
    expect([...seen].sort()).toEqual([...fullIds].sort());
  });

  it('rejects tampered, foreign and inconsistent shards and indexes', () => {
    const pack = build();
    const sharding = pack.sharding;
    const [first, second] = pack.shards;
    if (!first || !second) throw new Error('expected two shards');
    const expected = { packId: 'dict-krdict' as const, version: 'test-1', sharding };
    // Another shard's bytes fail the SHA-256 recorded for this one.
    expect(() =>
      decodeDictionaryShard(second.encoded.bytes, { ...expected, shard: first.descriptor }),
    ).toThrow(/SHA-256/);
    // A shard of another pack version (hash recomputed) is refused.
    const foreign = encode({
      shard: {
        format_version: 2,
        pack_id: 'dict-krdict',
        version: 'other',
        key: first.descriptor.key,
      },
      indices: [],
      entries: [],
    });
    expect(() =>
      decodeDictionaryShard(foreign.bytes, {
        ...expected,
        shard: { ...first.descriptor, sha256: foreign.sha256, entry_count: 0 },
      }),
    ).toThrow(/does not belong/);
    // An index whose shard counts don't add up is refused.
    const badIndex = encode({
      manifest: {
        ...MANIFEST,
        format_version: 2,
        sharding: { ...sharding, total_entries: ENTRIES.length + 1 },
      },
      entries: ENTRIES.map(toDictionaryStubEntry),
    });
    expect(() => decodePackArchive(badIndex.bytes)).toThrow(/manifest says/);
    // format_version 2 is only for dictionary indexes.
    const strokes = encode({
      manifest: { ...MANIFEST, id: 'strokes-zh-mmah', kind: 'strokes', format_version: 2 },
      characters: {},
    });
    expect(() => decodePackArchive(strokes.bytes)).toThrow(/format_version/);
  });

  it('keeps loading unsharded (format 1) packs exactly as before', () => {
    const payload: DictionaryPackPayload = { manifest: MANIFEST, entries: ENTRIES };
    const decoded = decodeIndex(encode(payload).bytes);
    expect(decoded.manifest.format_version).toBe(1);
    expect(decoded.manifest.sharding).toBeUndefined();
    expect(decoded.entries).toHaveLength(ENTRIES.length);
    expect(decoded.entries[2]?.senses?.[0]?.examples).toHaveLength(2);
    // A stray `sharding` on a format 1 manifest is ignored, not trusted.
    const stray = decodeIndex(
      encode({ manifest: { ...MANIFEST, sharding: build().sharding }, entries: ENTRIES }).bytes,
    );
    expect(stray.manifest.sharding).toBeUndefined();
    expect(materializeDictionaryEntries('dict-krdict', stray.entries).some((r) => r.stub)).toBe(
      false,
    );
  });

  it('splits inside one initial consonant only when it alone is over the limit', () => {
    const hieut = ENTRIES.filter((e) => /^[학한]/.test(e.headword));
    // Any shard of 3+ entries is "too big": the ㅎ words must split between 학 and 한.
    const atMostTwo = (indices: readonly number[]) => (indices.length > 2 ? 10_000 : 1);
    const plans = planDictionaryShards(hieut, { maxShardBytes: 100, measure: atMostTwo });
    expect(plans.map((p) => [p.from, p.to, p.indices.map((i) => hieut[i]?.headword)])).toEqual([
      ['가', String.fromCodePoint(0xd55b), ['학교']],
      ['한', '힣', ['한국', '한국어']],
    ]);
    // 한국 and 한국어 share their first syllable, which can't be split.
    const atMostOne = (indices: readonly number[]) => (indices.length > 1 ? 10_000 : 1);
    expect(() => planDictionaryShards(hieut, { maxShardBytes: 100, measure: atMostOne })).toThrow(
      /starting with "한"/,
    );
  });

  it('accepts a sharded pack in packs.json and rejects unknown schemes', () => {
    const pack = build();
    const entry = {
      id: 'dict-krdict',
      kind: 'dictionary',
      name: 'KRDict',
      description: 'Korean',
      version: 'test-1',
      language: 'ko',
      url: 'https://packs.example.com/dict-krdict.json.gz',
      compressed_bytes: pack.index.encoded.compressed_bytes,
      entry_count: ENTRIES.length,
      sha256: pack.index.encoded.sha256,
      license_name: 'CC BY-SA 2.0 KR',
      license_url: 'https://creativecommons.org/licenses/by-sa/2.0/kr/',
      attribution: 'NIKL',
      source_url: 'https://krdict.korean.go.kr/',
      shards: { scheme: 'first-syllable-v1', count: pack.shards.length, compressed_bytes: 1234 },
    };
    const catalog = (e: unknown) => JSON.stringify({ format_version: 1, name: 'T', packs: [e] });
    expect(parseAndValidatePackCatalog(catalog(entry)).packs[0]?.shards?.count).toBe(
      pack.shards.length,
    );
    expect(() =>
      parseAndValidatePackCatalog(catalog({ ...entry, shards: { ...entry.shards, scheme: 'x' } })),
    ).toThrow();
  });
});
