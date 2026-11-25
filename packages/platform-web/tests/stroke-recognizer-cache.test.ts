import { buildStrokeLookupIndex, type StrokeLookupIndex } from '@flash/core/drawing';
import type { InstalledPackInfo } from '@flash/platform';
import { describe, expect, it } from 'vitest';
import { WebStrokeRecognizer } from '../src/drawing/web-stroke-recognizer.ts';
import type { DexiePackStorage, StoredStrokeRow } from '../src/packs/dexie-pack-storage.ts';

type Script = 'ja' | 'zh-Hans';
const HORIZONTAL = [
  [
    [140, 460],
    [512, 460],
    [884, 460],
  ],
];
const VERTICAL = [
  [
    [512, 140],
    [512, 884],
  ],
];
const DRAWN_HORIZONTAL = [
  [
    { x: 30, y: 110, t: 0 },
    { x: 110, y: 110, t: 30 },
    { x: 200, y: 110, t: 60 },
  ],
];

function pack(id: string, installedAt: number, script?: Script): InstalledPackInfo {
  return {
    id,
    kind: script ? 'strokes' : 'dictionary',
    name: id,
    version: '1',
    language: script ?? 'ko',
    ...(script ? { script } : {}),
    entryCount: 1,
    byteSize: 1,
    installedAt,
    licenseName: 'x',
    licenseUrl: 'x',
    attribution: 'x',
    sourceUrl: 'x',
  } as InstalledPackInfo;
}

/** A pack store that counts the full loads P6 is about. */
function fakeStorage() {
  const calls = { strokeIndex: 0, strokeRows: 0, hanja: 0 };
  const store = {
    packs: [] as InstalledPackInfo[],
    indexes: new Map<Script, StrokeLookupIndex>(),
    rows: new Map<Script, StoredStrokeRow[]>(),
    hanja: new Set<string>(),
  };
  const storage = {
    listInstalledPacks: async () => [...store.packs],
    getStrokeIndex: async (script: Script) => {
      calls.strokeIndex += 1;
      return store.indexes.get(script);
    },
    listStrokesByScript: async (script: Script) => {
      calls.strokeRows += 1;
      return store.rows.get(script) ?? [];
    },
    countStrokesByScript: async (script: Script) => store.rows.get(script)?.length ?? 0,
    listInstalledHanjaCharacters: async () => {
      calls.hanja += 1;
      return new Set(store.hanja);
    },
  };
  return { calls, store, storage: storage as unknown as DexiePackStorage };
}

describe('WebStrokeRecognizer caches its indexes by pack install (P6)', () => {
  it('loads each stroke index and the Hanja set once per install, not once per call', async () => {
    const { calls, store, storage } = fakeStorage();
    store.packs = [
      pack('strokes-zh-mmah', 1, 'zh-Hans'),
      pack('strokes-ja-kanjivg', 1, 'ja'),
      pack('dict-hanja-unihan', 1),
    ];
    store.indexes.set(
      'zh-Hans',
      buildStrokeLookupIndex('zh-Hans', [{ char: '一', medians: HORIZONTAL }]),
    );
    store.indexes.set('ja', buildStrokeLookupIndex('ja', [{ char: '丨', medians: VERTICAL }]));
    store.hanja = new Set(['一']);
    const recognizer = new WebStrokeRecognizer(storage);

    for (let i = 0; i < 5; i++) {
      const out = await recognizer.recognize(DRAWN_HORIZONTAL, { lang: 'ko', maxResults: 3 });
      expect(out[0]?.character).toBe('一');
    }
    expect(await recognizer.isReady('ko')).toBe(true);
    // Before P6: 2 index reads and 1 Hanja dictionary read on every call (12 and 5 here).
    expect(calls.strokeIndex).toBe(2);
    expect(calls.hanja).toBe(1);
  });

  it('reloads only the pack that was reinstalled or removed', async () => {
    const { calls, store, storage } = fakeStorage();
    store.packs = [pack('strokes-zh-mmah', 1, 'zh-Hans'), pack('dict-hanja-unihan', 1)];
    store.indexes.set(
      'zh-Hans',
      buildStrokeLookupIndex('zh-Hans', [{ char: '一', medians: HORIZONTAL }]),
    );
    store.hanja = new Set(['一']);
    const recognizer = new WebStrokeRecognizer(storage);
    await recognizer.recognize(DRAWN_HORIZONTAL, { lang: 'zh-Hans' });
    expect(calls.strokeIndex).toBe(1);

    // Reinstall with different data: a new installedAt, so the new index is used.
    store.indexes.set(
      'zh-Hans',
      buildStrokeLookupIndex('zh-Hans', [{ char: '二', medians: HORIZONTAL }]),
    );
    store.packs = [pack('strokes-zh-mmah', 2, 'zh-Hans'), pack('dict-hanja-unihan', 1)];
    const after = await recognizer.recognize(DRAWN_HORIZONTAL, { lang: 'zh-Hans' });
    expect(after[0]?.character).toBe('二');
    expect(calls.strokeIndex).toBe(2);

    // Korean also reads the (empty) Japanese index, once.
    await recognizer.recognize(DRAWN_HORIZONTAL, { lang: 'ko' });
    expect(calls.hanja).toBe(1);
    expect(calls.strokeIndex).toBe(3);
    // Removing the Hanja pack drops its set; the stroke indexes stay loaded.
    store.packs = [pack('strokes-zh-mmah', 2, 'zh-Hans')];
    store.hanja = new Set();
    await recognizer.recognize(DRAWN_HORIZONTAL, { lang: 'ko' });
    expect(calls.hanja).toBe(2);
    expect(calls.strokeIndex).toBe(3);
  });

  it('without a stroke pack, rebuilds from cached deck strokes only when they change', async () => {
    const { calls, store, storage } = fakeStorage();
    const row = (char: string, medians: number[][][]): StoredStrokeRow =>
      ({ script: 'ja', char, data: { strokes: [], medians }, updatedAt: 0 }) as StoredStrokeRow;
    store.rows.set('ja', [row('丨', VERTICAL)]);
    const recognizer = new WebStrokeRecognizer(storage);
    await recognizer.recognize(DRAWN_HORIZONTAL, { lang: 'ja' });
    await recognizer.recognize(DRAWN_HORIZONTAL, { lang: 'ja' });
    expect(calls.strokeRows).toBe(1);

    store.rows.set('ja', [row('丨', VERTICAL), row('一', HORIZONTAL)]);
    const out = await recognizer.recognize(DRAWN_HORIZONTAL, { lang: 'ja' });
    expect(out[0]?.character).toBe('一');
    expect(calls.strokeRows).toBe(2);
  });
});
