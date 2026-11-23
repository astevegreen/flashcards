/**
 * Smoke test for REAL packs produced by `node scripts/build-packs.mjs --full`.
 *
 * Skipped unless a full build exists (default `dist-packs/` at the repo root, or `FULL_PACKS_DIR`), so
 * `pnpm test` never requires downloading upstream data. Loads real packs through the production
 * `WebPackManager` (sha256 verification, gzip caps, IndexedDB indexing) and queries them with the
 * existing dictionary search and stroke provider.
 */
import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAndValidatePackCatalog } from '@flash/core/dictionary';
import { describe, expect, it } from 'vitest';
import { WebDictionaryService } from '../src/dictionary/web-dictionary-service.ts';
import { WebStrokeDataProvider } from '../src/drawing/web-stroke-provider.ts';
import { DexiePackStorage } from '../src/packs/dexie-pack-storage.ts';
import { WebPackManager } from '../src/packs/web-pack-manager.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKS_DIR = process.env['FULL_PACKS_DIR']
  ? resolve(process.env['FULL_PACKS_DIR'])
  : join(REPO_ROOT, 'dist-packs');
const CATALOG_PATH = join(PACKS_DIR, 'packs.json');
const HAS_FULL_BUILD = existsSync(CATALOG_PATH);

describe.skipIf(!HAS_FULL_BUILD)('full open-data packs (build-packs --full) smoke test', () => {
  const catalog = HAS_FULL_BUILD
    ? parseAndValidatePackCatalog(readFileSync(CATALOG_PATH, 'utf8'), { allowRelativeUrls: true })
    : undefined;

  function packBytes(id: string): { bytes: Uint8Array; sha256: string; entryCount: number } {
    const entry = catalog?.packs.find((p) => p.id === id);
    if (!entry?.sha256) throw new Error(`packs.json has no sha256 entry for ${id}`);
    const file = entry.url.split('/').pop() ?? '';
    return {
      bytes: new Uint8Array(readFileSync(join(PACKS_DIR, file))),
      sha256: entry.sha256,
      entryCount: entry.entry_count,
    };
  }

  it('catalog lists all six real packs, none a starter fixture, each within 25 MiB', () => {
    // KRDict is a manual download, so it is checked separately when present.
    const ids = catalog?.packs.map((p) => p.id).filter((id) => id !== 'dict-krdict');
    expect(ids?.sort()).toEqual([
      'dict-cc-cedict',
      'dict-hanja-unihan',
      'dict-jmdict',
      'dict-kanjidic2',
      'strokes-ja-kanjivg',
      'strokes-zh-mmah',
    ]);
    for (const p of catalog?.packs ?? []) {
      expect(p.version).not.toContain('starter');
      expect(p.compressed_bytes).toBeLessThanOrEqual(25 * 1024 * 1024);
    }
  });

  it('installs the real Unihan Hanja + KANJIDIC2 packs and searches them', async () => {
    const storage = new DexiePackStorage(`full-smoke-dict-${Date.now()}`);
    const manager = new WebPackManager({ packStorage: storage, allowRelativeUrls: true });
    const dict = new WebDictionaryService(storage);

    const hanja = packBytes('dict-hanja-unihan');
    const info = await manager.installPackFromBytes(hanja.bytes, { expectedSha256: hanja.sha256 });
    expect(info.entryCount).toBe(hanja.entryCount);
    expect(info.entryCount).toBeGreaterThan(8000);
    expect(info.licenseName).toBe('Unicode License v3');

    const kanjidic = packBytes('dict-kanjidic2');
    await manager.installPackFromBytes(kanjidic.bytes, { expectedSha256: kanjidic.sha256 });

    const byChar = await dict.lookupCharacter('學');
    const hak = byChar.find((e) => e.packId === 'dict-hanja-unihan');
    expect(hak?.readings).toContain('학');
    expect(hak?.altForms).toContain('学');
    expect(hak?.grade).toMatch(/Education/);

    const byHangul = await dict.search('학', { packIds: ['dict-hanja-unihan'] });
    expect(byHangul.map((e) => e.headword)).toContain('學');

    const byEnglish = await dict.search('eat', { packIds: ['dict-kanjidic2'] });
    expect(byEnglish.map((e) => e.headword)).toContain('食');
  }, 120_000);

  const krdict = catalog?.packs.find((p) => p.id === 'dict-krdict');
  it.skipIf(!krdict)(
    'installs the real KRDict pack (sharded or not) and searches it',
    async () => {
      // Serve the build output by URL so a sharded pack's shards load like they do in the app.
      const fetchImpl = ((input: RequestInfo | URL) => {
        const file = String(input).split('/').pop() ?? '';
        const path = join(PACKS_DIR, file);
        return Promise.resolve(
          existsSync(path)
            ? new Response(new Uint8Array(readFileSync(path)))
            : new Response('missing', { status: 404 }),
        );
      }) as typeof fetch;
      const storage = new DexiePackStorage(`full-smoke-krdict-${Date.now()}`);
      const manager = new WebPackManager({
        packStorage: storage,
        allowRelativeUrls: true,
        fetchImpl,
      });
      const dict = new WebDictionaryService(storage, { allowRelativeUrls: true, fetchImpl });
      if (!krdict) return;
      const info = await manager.installPackFromCatalog(krdict);
      expect(info.entryCount).toBe(krdict.entry_count);
      expect(info.shardCount).toBe(krdict.shards?.count);

      const [eat] = await dict.search('먹었어요', { packIds: ['dict-krdict'] });
      expect(eat?.headword).toBe('먹다');
      expect(eat?.stub).toBeUndefined();
      expect(eat?.senses?.some((s) => s.examples && s.examples.length > 0)).toBe(true);
      const english = await dict.search('school', {
        packIds: ['dict-krdict'],
        direction: 'from-english',
      });
      expect(english.map((e) => e.headword)).toContain('학교');
      expect((await dict.search('ㅎㄱ', { packIds: ['dict-krdict'] })).length).toBeGreaterThan(0);
    },
    300_000,
  );

  it('installs the real Make Me a Hanzi stroke pack and serves strokes offline', async () => {
    const storage = new DexiePackStorage(`full-smoke-strokes-${Date.now()}`);
    const manager = new WebPackManager({ packStorage: storage, allowRelativeUrls: true });
    const strokes = new WebStrokeDataProvider({ packStorage: storage });

    const mmah = packBytes('strokes-zh-mmah');
    const info = await manager.installPackFromBytes(mmah.bytes, { expectedSha256: mmah.sha256 });
    expect(info.script).toBe('zh-Hans');
    expect(info.entryCount).toBeGreaterThan(9000);

    const xue = await strokes.getCharacterData('zh-Hans', '学', { allowNetwork: false });
    expect(xue?.strokes).toHaveLength(8);
    expect(await strokes.getCharacterData('ja', '学', { allowNetwork: false })).toBeNull();
  }, 180_000);
});
