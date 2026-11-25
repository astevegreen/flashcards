import 'fake-indexeddb/auto';
import { gzipSync } from 'node:zlib';
import { sha256Hex } from '@flash/core';
import { describe, expect, it } from 'vitest';
import { WebDictionaryService } from '../src/dictionary/web-dictionary-service.ts';
import { WebStrokeDataProvider } from '../src/drawing/web-stroke-provider.ts';
import { WebStrokeRecognizer } from '../src/drawing/web-stroke-recognizer.ts';
import { DexiePackStorage } from '../src/packs/dexie-pack-storage.ts';
import { WebPackManager } from '../src/packs/web-pack-manager.ts';

function makeGzipPack(payload: unknown): { bytes: Uint8Array; sha256: string } {
  const bytes = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')));
  return { bytes, sha256: sha256Hex(bytes) };
}

describe('Phase 6 web pack manager, stroke provider, recognizer & offline dictionary', () => {
  it('installs, queries, isolates ja/zh-Hans strokes, recognizes handwriting, and removes packs cleanly', async () => {
    const storage = new DexiePackStorage(`test-p6-${Date.now()}`);

    const hanjaPack = makeGzipPack({
      manifest: {
        format_version: 1,
        id: 'dict-hanja-unihan',
        kind: 'dictionary',
        name: 'Hanja Dictionary',
        version: '2026.11.0',
        language: 'ko',
        description: 'Unihan Hanja',
        license_name: 'Unicode License v3',
        license_url: 'https://www.unicode.org/license.txt',
        attribution: 'Unicode, Inc.',
        source_url: 'https://www.unicode.org/charts/unihan.html',
      },
      entries: [
        {
          headword: '日',
          readings: ['일'],
          eumhun: ['날 일'],
          meanings: ['sun', 'day'],
          strokeCount: 4,
          radical: '日',
          grade: 'Education Hanja',
        },
        {
          headword: '一',
          readings: ['일'],
          eumhun: ['한 일'],
          meanings: ['one'],
          strokeCount: 1,
          radical: '一',
          grade: 'Education Hanja',
        },
      ],
    });

    const jaStrokePack = makeGzipPack({
      manifest: {
        format_version: 1,
        id: 'strokes-ja-kanjivg',
        kind: 'strokes',
        name: 'KanjiVG JA',
        version: '2026.11.0',
        language: 'ja',
        script: 'ja',
        description: 'JA KanjiVG strokes',
        license_name: 'CC BY-SA 3.0',
        license_url: 'https://creativecommons.org/licenses/by-sa/3.0/',
        attribution: 'KanjiVG',
        source_url: 'https://kanjivg.tagaini.net/',
      },
      characters: {
        食: {
          strokes: ['M 1 1 L 2 2 Z', 'M 3 3 L 4 4 Z'],
          medians: [
            [
              [100, 800],
              [500, 400],
            ],
            [
              [500, 800],
              [900, 400],
            ],
          ],
        },
      },
    });

    const zhStrokePack = makeGzipPack({
      manifest: {
        format_version: 1,
        id: 'strokes-zh-mmah',
        kind: 'strokes',
        name: 'Make Me a Hanzi ZH',
        version: '2026.11.0',
        language: 'zh-Hans',
        script: 'zh-Hans',
        description: 'ZH MMAH strokes',
        license_name: 'Arphic Public License (1999)',
        license_url: 'https://ftp.gnu.org/gnu/non-gnu/chinese-fonts-truetype/LICENSE',
        attribution: 'Make Me a Hanzi',
        source_url: 'https://github.com/skishore/makemeahanzi',
      },
      characters: {
        食: {
          strokes: ['M 10 10 L 20 20 Z'],
          medians: [
            [
              [200, 700],
              [800, 700],
            ],
          ],
        },
        一: {
          strokes: ['M 140 480 L 884 480 L 884 440 L 140 440 Z'],
          medians: [
            [
              [140, 460],
              [512, 460],
              [884, 460],
            ],
          ],
        },
      },
    });

    const perChar本 = {
      strokes: ['M 180 620 L 844 620 Z'],
      medians: [
        [
          [180, 620],
          [844, 620],
        ],
      ],
    };

    const catalogJson = JSON.stringify({
      format_version: 1,
      name: 'Test Catalog',
      packs: [
        {
          id: 'dict-hanja-unihan',
          kind: 'dictionary',
          name: 'Hanja Dictionary',
          description: 'Unihan Hanja',
          version: '2026.11.0',
          language: 'ko',
          url: 'https://packs.example.com/dict-hanja-unihan.json.gz',
          compressed_bytes: hanjaPack.bytes.byteLength,
          entry_count: 2,
          sha256: hanjaPack.sha256,
          license_name: 'Unicode License v3',
          license_url: 'https://www.unicode.org/license.txt',
          attribution: 'Unicode, Inc.',
          source_url: 'https://www.unicode.org/charts/unihan.html',
        },
        {
          id: 'strokes-ja-kanjivg',
          kind: 'strokes',
          name: 'KanjiVG JA',
          description: 'JA strokes',
          version: '2026.11.0',
          language: 'ja',
          script: 'ja',
          url: 'https://packs.example.com/strokes-ja-kanjivg.json.gz',
          compressed_bytes: jaStrokePack.bytes.byteLength,
          entry_count: 1,
          sha256: jaStrokePack.sha256,
          license_name: 'CC BY-SA 3.0',
          license_url: 'https://creativecommons.org/licenses/by-sa/3.0/',
          attribution: 'KanjiVG',
          source_url: 'https://kanjivg.tagaini.net/',
          char_url_template: 'https://packs.example.com/strokes/ja/{hex5}.json',
        },
      ],
    });

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://packs.example.com/packs.json') {
        return new Response(catalogJson, {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"v1"' },
        });
      }
      if (url === 'https://packs.example.com/dict-hanja-unihan.json.gz') {
        return new Response(new Uint8Array(hanjaPack.bytes), { status: 200 });
      }
      if (url === 'https://packs.example.com/strokes-ja-kanjivg.json.gz') {
        return new Response(new Uint8Array(jaStrokePack.bytes), { status: 200 });
      }
      if (url === 'https://packs.example.com/strokes/ja/0672c.json') {
        return new Response(JSON.stringify(perChar本), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const manager = new WebPackManager({
      packStorage: storage,
      defaultCatalogUrl: 'https://packs.example.com/packs.json',
      fetchImpl: mockFetch,
    });
    const strokeProvider = new WebStrokeDataProvider({
      packStorage: storage,
      packManager: manager,
      fetchImpl: mockFetch,
    });
    const dictService = new WebDictionaryService(storage);
    const recognizer = new WebStrokeRecognizer(storage);

    // 1. Fetch catalog & install Hanja dictionary + JA stroke pack
    const catalog = await manager.fetchCatalog();
    expect(catalog.packs).toHaveLength(2);
    const [pack0, pack1] = catalog.packs;
    expect(pack0).toBeDefined();
    expect(pack1).toBeDefined();
    if (pack0) await manager.installPackFromCatalog(pack0);
    if (pack1) await manager.installPackFromCatalog(pack1);
    // Also test local pack import for ZH strokes
    await manager.installPackFromBytes(zhStrokePack.bytes, {
      expectedSha256: zhStrokePack.sha256,
    });

    const installed = await manager.listInstalledPacks();
    expect(installed).toHaveLength(3);
    expect(await manager.getStorageUsageBytes()).toBeGreaterThan(0);

    // 2. Verify JA (KanjiVG) and ZH (MMAH) stroke data stay strictly separate for `食`
    const jaShi = await strokeProvider.getCharacterData('ja', '食', { allowNetwork: false });
    const zhShi = await strokeProvider.getCharacterData('zh-Hans', '食', { allowNetwork: false });
    expect(jaShi?.strokes).toHaveLength(2);
    expect(zhShi?.strokes).toHaveLength(1);

    // 3. Per-deck stroke pre-caching fetches missing `本` from packs.json host template & caches offline
    const precacheRes = await strokeProvider.precacheCharacters('ja', ['食', '本']);
    expect(precacheRes.cached).toBe(2);
    expect(precacheRes.failed).toEqual([]);
    expect(await strokeProvider.hasCachedCharacter('ja', '本')).toBe(true);

    // 4. Offline dictionary lookup (character + English meaning)
    const byChar = await dictService.lookupCharacter('日');
    expect(byChar[0]?.eumhun).toEqual(['날 일']);
    const byEnglish = await dictService.search('sun');
    expect(byEnglish[0]?.headword).toBe('日');

    // 5. Handwriting recognizer matches horizontal stroke -> `一`
    expect(await recognizer.isReady('ko')).toBe(true);
    const candidates = await recognizer.recognize(
      [
        [
          { x: 30, y: 110, t: 0 },
          { x: 110, y: 110, t: 30 },
          { x: 200, y: 110, t: 60 },
        ],
      ],
      { lang: 'ko', maxResults: 5 },
    );
    expect(candidates[0]?.character).toBe('一');

    // 6. Clean pack removal
    await manager.removePack('dict-hanja-unihan');
    expect(await dictService.lookupCharacter('日')).toEqual([]);
    expect((await manager.listInstalledPacks()).map((p) => p.id)).not.toContain(
      'dict-hanja-unihan',
    );

    recognizer.dispose();
    storage.close();
  });
});
