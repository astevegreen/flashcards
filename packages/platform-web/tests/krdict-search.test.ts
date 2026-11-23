import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('Phase 10 Korean search over the installed KRDict starter pack (IndexedDB)', () => {
  it('finds lemmas from inflected Hangul, 초성, romanization, English and Hanja', async () => {
    const storage = new DexiePackStorage(`test-p10-${Date.now()}`);
    const manager = new WebPackManager({
      packStorage: storage,
      defaultCatalogUrl: 'https://packs.example.com/packs.json',
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    for (const file of ['dict-krdict.json.gz', 'dict-hanja-unihan.json.gz']) {
      await manager.installPackFromBytes(new Uint8Array(readFileSync(join(PACKS_DIR, file))));
    }
    const svc = new WebDictionaryService(storage);
    const first = async (q: string, packIds?: ['dict-krdict']) =>
      (await svc.search(q, packIds ? { packIds } : {}))[0];

    expect((await first('먹었어요'))?.headword).toBe('먹다');
    expect((await first('도와요'))?.headword).toBe('돕다');
    expect((await first('들어요'))?.headword).toBe('듣다');
    expect((await first('몰라요'))?.headword).toBe('모르다');
    // 사세요 is genuinely ambiguous: 살다 (live) and 사다 (buy) both conjugate to it.
    const saseyo = (await svc.search('사세요')).slice(0, 2).map((e) => e.headword);
    expect(saseyo.sort()).toEqual(['사다', '살다']);
    expect((await first('공부해요'))?.headword).toBe('공부하다');
    expect((await first('hanguk'))?.headword).toBe('한국');
    expect((await first('meogeosseoyo'))?.headword).toBe('먹다');
    expect((await first('eat', ['dict-krdict']))?.headword).toBe('먹다');

    const choseong = (await svc.search('ㅎㄱ')).map((e) => e.headword);
    expect(choseong.slice(0, 2).sort()).toEqual(['학교', '한국']);
    expect(choseong).toContain('한국어');

    const hanja = await svc.search('韓國');
    expect(hanja[0]?.headword).toBe('한국');

    const korea = await first('먹다');
    expect(korea?.packId).toBe('dict-krdict');
    // 먹다's first sense has a hand-written Korean definition (App badge); the second is KRDict's.
    expect(korea?.senses?.[0]).toMatchObject({ equivalents: ['eat'], source: 'app' });
    expect(korea?.senses?.[1]).toMatchObject({ equivalents: ['take'], source: 'krdict' });
    expect(korea?.level).toBe('beginner');

    // Existing Hanja pack search still works next to the Korean words pack.
    expect((await svc.search('learn', { packIds: ['dict-hanja-unihan'] }))[0]?.headword).toBe('學');
    storage.close();
  });
});
