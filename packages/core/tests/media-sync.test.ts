import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  computeTtsCacheKey,
  computeTtsLangCacheKey,
  createEmptyState,
  createEventFactory,
  createHlcState,
  exportFlashpkg,
  importFlashpkg,
  type FlashEvent,
} from '../src/index.ts';
import { sha256Hex } from '../src/sources/hash.ts';
import {
  createInitialSyncCursor,
  mediaObjectPath,
  runSync,
  SyncCodecError,
  SyncTransportError,
  type SyncFileInfo,
  type SyncMediaStore,
  type SyncStoreTransport,
} from '../src/sync/index.ts';

class TestMemoryTransport implements SyncStoreTransport {
  readonly files = new Map<string, Uint8Array>();

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const out: SyncFileInfo[] = [];
    for (const [path, data] of this.files.entries()) {
      if (path.startsWith(prefix)) {
        out.push({ path, size: data.byteLength, updatedAt: 1 });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new SyncTransportError('NOT_FOUND', `Missing ${path}`);
    return new Uint8Array(data);
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    if (opts?.ifAbsent && this.files.has(path)) {
      throw new SyncTransportError('ALREADY_EXISTS', `Exists ${path}`);
    }
    this.files.set(path, new Uint8Array(data));
  }
}

function createMemoryMediaStore(): SyncMediaStore & {
  blobs: Map<string, { hash: string; mime: string; bytes: Uint8Array }>;
} {
  const blobs = new Map<string, { hash: string; mime: string; bytes: Uint8Array }>();
  return {
    blobs,
    async getLocalMedia(hash) {
      return blobs.get(hash);
    },
    async putLocalMedia(media) {
      blobs.set(media.hash, media);
    },
  };
}

describe('Media sync (§4.2) & .flashpkg media/page round-trip', () => {
  it('validates mediaObjectPath against traversal and unsafe extensions', () => {
    const hash = 'a'.repeat(64);
    expect(mediaObjectPath(hash, 'webp')).toBe(`media/aa/${hash}.webp`);
    expect(() => mediaObjectPath('../etc/passwd', 'png')).toThrow(SyncCodecError);
    expect(() => mediaObjectPath(hash, 'svg')).toThrow(SyncCodecError);
    expect(() => mediaObjectPath(hash, 'html')).toThrow(SyncCodecError);
  });

  it('pushes MediaAdded blobs before head.json, pulls & verifies SHA-256 on Device B, and is idempotent', async () => {
    const transport = new TestMemoryTransport();
    const storeA = createMemoryMediaStore();
    const storeB = createMemoryMediaStore();

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const hash = sha256Hex(pngBytes);
    await storeA.putLocalMedia({ hash, mime: 'image/png', bytes: pngBytes });

    const t0 = Date.UTC(2026, 4, 1, 12, 0, 0);
    const factoryA = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const eventsA: FlashEvent[] = [
      factoryA.create(
        'MediaAdded',
        { media: { hash, ext: 'png', mime: 'image/png', size: pngBytes.byteLength } },
        t0,
      ),
    ];

    const resA1 = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: factoryA.getSeq(),
      getLocalEventsAfterSeq: async (afterSeq) => eventsA.filter((e) => e.seq > afterSeq),
      mediaStore: storeA,
      nowMs: () => t0 + 100,
    });

    expect(resA1.status).toBe('ok');
    expect(resA1.pushedMediaCount).toBe(1);
    const expectedPath = mediaObjectPath(hash, 'png');
    expect(transport.files.has(expectedPath)).toBe(true);

    // Second sync on Device A should be idempotent (0 pushed media)
    const resA2 = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: resA1.cursor,
      localOwnSeq: factoryA.getSeq(),
      getLocalEventsAfterSeq: async (afterSeq) => eventsA.filter((e) => e.seq > afterSeq),
      mediaStore: storeA,
      nowMs: () => t0 + 200,
    });
    expect(resA2.pushedMediaCount).toBe(0);

    // Device B pulls MediaAdded + media blob
    const resB1 = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      getLocalEventsAfterSeq: async () => [],
      mediaStore: storeB,
      nowMs: () => t0 + 300,
    });
    expect(resB1.status).toBe('ok');
    expect(resB1.pulledMediaCount).toBe(1);
    expect(storeB.blobs.get(hash)?.bytes).toEqual(pngBytes);

    // Re-sync on Device B pulls 0 duplicate blobs
    const resB2 = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: resB1.cursor,
      localOwnSeq: 0,
      getLocalEventsAfterSeq: async () => [],
      mediaStore: storeB,
      nowMs: () => t0 + 400,
    });
    expect(resB2.pulledMediaCount).toBe(0);
  });

  it('rejects tampered remote media blobs and oversized blobs on pull (§13)', async () => {
    const transport = new TestMemoryTransport();
    const storeA = createMemoryMediaStore();
    const storeB = createMemoryMediaStore();

    const goodBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
    const hash = sha256Hex(goodBytes);
    await storeA.putLocalMedia({ hash, mime: 'image/png', bytes: goodBytes });

    const t0 = Date.UTC(2026, 4, 1, 12, 0, 0);
    const factoryA = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const eventsA: FlashEvent[] = [
      factoryA.create(
        'MediaAdded',
        { media: { hash, ext: 'png', mime: 'image/png', size: goodBytes.byteLength } },
        t0,
      ),
    ];

    await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: factoryA.getSeq(),
      getLocalEventsAfterSeq: async (afterSeq) => eventsA.filter((e) => e.seq > afterSeq),
      mediaStore: storeA,
      nowMs: () => t0 + 100,
    });

    // Tamper with remote media bytes
    const remotePath = mediaObjectPath(hash, 'png');
    transport.files.set(remotePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]));

    const resTampered = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      getLocalEventsAfterSeq: async () => [],
      mediaStore: storeB,
      nowMs: () => t0 + 200,
    });
    expect(resTampered.pulledMediaCount).toBe(0);
    expect(storeB.blobs.has(hash)).toBe(false);
    expect(resTampered.mediaWarnings?.some((w) => /SHA-256 mismatch/i.test(w))).toBe(true);

    // Restore valid bytes, then test maxMediaBlobBytes cap
    transport.files.set(remotePath, goodBytes);
    const resOversized = await runSync({
      transport,
      deviceId: 'dev-c',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      getLocalEventsAfterSeq: async () => [],
      mediaStore: createMemoryMediaStore(),
      maxMediaBlobBytes: 4,
      nowMs: () => t0 + 300,
    });
    expect(resOversized.pulledMediaCount).toBe(0);
    expect(resOversized.mediaWarnings?.some((w) => /exceeds max size/i.test(w))).toBe(true);

    // A transport that refuses the blob past its read cap (a SyncCodecError) gets the same skip.
    const realRead = transport.read.bind(transport);
    transport.read = async (path) => {
      if (path === remotePath) throw new SyncCodecError(`"${path}" is too large to read`);
      return realRead(path);
    };
    const resCapped = await runSync({
      transport,
      deviceId: 'dev-d',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      getLocalEventsAfterSeq: async () => [],
      mediaStore: createMemoryMediaStore(),
      nowMs: () => t0 + 400,
    });
    expect(resCapped.status).toBe('ok');
    expect(resCapped.pulledMediaCount).toBe(0);
    expect(resCapped.mediaWarnings).toContain(
      `Rejected remote media "${remotePath}": "${remotePath}" is too large to read`,
    );
  });

  it('packs and re-imports pages/*.md and media/<sha256>.<ext> in .flashpkg', () => {
    const t0 = Date.UTC(2026, 4, 1, 12, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const imgBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42, 43, 44, 45,
    ]);
    const imgHash = sha256Hex(imgBytes);

    const state = applyEvents(createEmptyState(), [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Media Deck',
          note_type_id: 'preset:vocab-ko',
          language: 'ko',
          created_at: t0,
        },
        t0,
      ),
      factory.create(
        'MediaAdded',
        { media: { hash: imgHash, ext: 'png', mime: 'image/png', size: imgBytes.byteLength } },
        t0 + 1,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: 'n1',
          deck_id: 'd1',
          source_key: 'k1',
          fields: { word: '바다', meaning: 'sea', image: `media:${imgHash}` },
          tags: ['nature'],
          created_order: 0,
        },
        t0 + 2,
      ),
      factory.create(
        'PageUpserted',
        {
          page_id: 'p1',
          slug: 'sea-lesson',
          title: 'Sea Lesson',
          markdown: `# Sea Lesson\n\n::image[Sea]{src="media:${imgHash}"}`,
          lang: 'ko',
          tags: ['nature'],
        },
        t0 + 3,
      ),
    ]);

    const archive = exportFlashpkg(state, {
      name: 'RoundTrip',
      mediaBlobs: new Map([[imgHash, imgBytes]]),
    });

    const freshState = createEmptyState();
    const factory2 = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 1000));
    const imported = importFlashpkg(archive, freshState, factory2, { nowMs: t0 + 1000 });

    expect(imported.decksImported).toBe(1);
    expect(imported.notesImported).toBe(1);
    expect(imported.pagesImported).toBe(1);
    expect(imported.extractedMedia).toHaveLength(1);
    expect(imported.extractedMedia[0]?.hash).toBe(imgHash);
    expect(imported.extractedMedia[0]?.bytes).toEqual(imgBytes);
  });

  it('syncs MediaAdded TTS MP3 clips with tts_key & tts_lang_key across devices with SHA-256 verification (§7.1)', async () => {
    const transport = new TestMemoryTransport();
    const storeA = createMemoryMediaStore();
    const storeB = createMemoryMediaStore();

    const mp3Bytes = new Uint8Array([
      0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb,
    ]);
    const hash = sha256Hex(mp3Bytes);
    const ttsKey = computeTtsCacheKey('먹습니다', 'google:ko-KR-Neural2-A');
    const ttsLangKey = computeTtsLangCacheKey('먹습니다', 'ko');
    await storeA.putLocalMedia({ hash, mime: 'audio/mpeg', bytes: mp3Bytes });

    const t0 = Date.UTC(2026, 4, 2, 12, 0, 0);
    const factoryA = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const eventsA: FlashEvent[] = [
      factoryA.create(
        'MediaAdded',
        {
          media: {
            hash,
            ext: 'mp3',
            mime: 'audio/mpeg',
            size: mp3Bytes.byteLength,
            tts_key: ttsKey,
            tts_lang_key: ttsLangKey,
          },
        },
        t0,
      ),
    ];

    const resA = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: factoryA.getSeq(),
      getLocalEventsAfterSeq: async (afterSeq) => eventsA.filter((e) => e.seq > afterSeq),
      mediaStore: storeA,
      nowMs: () => t0 + 100,
    });
    expect(resA.status).toBe('ok');
    expect(resA.pushedMediaCount).toBe(1);
    expect(transport.files.has(mediaObjectPath(hash, 'mp3'))).toBe(true);

    const resB = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      getLocalEventsAfterSeq: async () => [],
      mediaStore: storeB,
      nowMs: () => t0 + 200,
    });
    expect(resB.status).toBe('ok');
    expect(resB.pulledMediaCount).toBe(1);
    expect(storeB.blobs.get(hash)?.bytes).toEqual(mp3Bytes);

    // Replaying Device B's pulled events populates ttsMediaByKey and ttsMediaByLangKey for key-less offline playback
    const stateB = applyEvents(createEmptyState(), resB.pulledEvents);
    expect(stateB.ttsMediaByKey.get(ttsKey)).toBe(hash);
    expect(stateB.ttsMediaByLangKey.get(ttsLangKey)).toBe(hash);
  });
});
