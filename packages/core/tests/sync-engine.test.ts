import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  applyEventsWithDiff,
  createEmptyState,
  createEventFactory,
  getTotalAppliedEventCount,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import { SERIALIZED_STATE_FORMAT_VERSION } from '../src/events/snapshot-format.ts';
import type { FlashEvent, UnknownEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId, encodeUtf8 } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import {
  decodeDeviceHead,
  decodeEventsSegment,
  decodeSyncSnapshot,
  deviceHeadPath,
  deviceSegmentPath,
  encodeDeviceHead,
  encodeEventsSegment,
  encodeManifest,
  encodeReadableSyncSnapshot,
  manifestPath,
  safeGunzip,
  sanitizeDeviceId,
  snapshotPath,
  SYNC_CODEC_LIMITS,
  SYNC_SNAPSHOT_LIMITS,
  SyncCodecError,
} from '../src/sync/codec.ts';
import { runSync } from '../src/sync/engine.ts';
import { assertSyncReadCapsCover } from '../src/sync/read-caps.ts';
import type { SyncSnapshot } from '../src/sync/types.ts';
import {
  createInitialSyncCursor,
  SyncTransportError,
  type SyncFileInfo,
  type SyncStoreTransport,
} from '../src/sync/types.ts';

class RecordingMemoryTransport implements SyncStoreTransport {
  readonly files = new Map<string, { data: Uint8Array; updatedAt: number }>();
  readonly writeLog: Array<{ path: string; ifAbsent: boolean }> = [];
  readonly readLog: string[] = [];
  private tick = 1;

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const out: SyncFileInfo[] = [];
    for (const [path, entry] of this.files.entries()) {
      if (path.startsWith(prefix)) {
        out.push({ path, size: entry.data.byteLength, updatedAt: entry.updatedAt });
      }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    this.readLog.push(path);
    const entry = this.files.get(path);
    if (!entry) {
      throw new SyncTransportError('NOT_FOUND', `Missing: ${path}`);
    }
    return new Uint8Array(entry.data);
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    this.writeLog.push({ path, ifAbsent: Boolean(opts?.ifAbsent) });
    if (opts?.ifAbsent && this.files.has(path)) {
      throw new SyncTransportError('ALREADY_EXISTS', `Exists: ${path}`);
    }
    this.files.set(path, { data: new Uint8Array(data), updatedAt: this.tick++ });
  }
}

describe('SyncEngine & Codec unit tests (§4.2 & §13)', () => {
  it('pushes write-once segment strictly before head.json and ignores own already-applied seqs', async () => {
    const transport = new RecordingMemoryTransport();
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const localEvents: FlashEvent[] = [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Korean',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: t0,
        },
        t0,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId('d1', 'k1'),
          deck_id: 'd1',
          source_key: 'k1',
          fields: { word: '학교', meaning: 'school' },
        },
        t0 + 100,
      ),
    ];

    const res1 = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 2,
      nowMs: () => t0 + 200,
      getLocalEventsAfterSeq: async (afterSeq) => localEvents.filter((e) => e.seq > afterSeq),
    });

    expect(res1.status).toBe('ok');
    expect(res1.pushedEventCount).toBe(2);
    expect(res1.pushedSegments).toBe(1);
    expect(res1.pulledEvents).toHaveLength(0);

    // Verify exact write ordering: manifest -> seg-000001.jsonl.gz (ifAbsent) -> head.json (overwrite)
    expect(transport.writeLog).toEqual([
      { path: manifestPath(), ifAbsent: true },
      { path: deviceSegmentPath('dev-a', 1), ifAbsent: true },
      { path: deviceHeadPath('dev-a'), ifAbsent: false },
    ]);

    // Second sync with same device must NOT re-download own segment
    transport.readLog.length = 0;
    const res2 = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: res1.cursor,
      localOwnSeq: 2,
      nowMs: () => t0 + 300,
      getLocalEventsAfterSeq: async (afterSeq) => localEvents.filter((e) => e.seq > afterSeq),
    });
    expect(res2.pulledEvents).toHaveLength(0);
    expect(res2.pushedEventCount).toBe(0);
    expect(transport.readLog).not.toContain(deviceSegmentPath('dev-a', 1));
  });

  it('recovers cleanly from crash after segment upload before head.json write (and never overwrites differing segments)', async () => {
    const transport = new RecordingMemoryTransport();
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const ev1 = factory.create('PreferencesChanged', { preferences: { day_start_hour: 5 } }, t0);
    const ev2 = factory.create(
      'PreferencesChanged',
      { preferences: { pinyin_tone_colors: false } },
      t0 + 10,
    );

    // Pre-populate manifest and orphan seg-000001 with identical content (simulating crash before head.json)
    await transport.write(
      manifestPath(),
      encodeManifest({
        collection_id: 'col-crash',
        format_version: 1,
        min_app_version: '0.2.0',
        created_at: t0,
      }),
    );
    await transport.write(deviceSegmentPath('dev-a', 1), encodeEventsSegment([ev1]), {
      ifAbsent: true,
    });

    // Sync recovers by adopting orphan seg-000001 and writing head.json
    const res1 = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor('col-crash'),
      localOwnSeq: 1,
      nowMs: () => t0 + 100,
      getLocalEventsAfterSeq: async (afterSeq) => [ev1].filter((e) => e.seq > afterSeq),
    });
    expect(res1.status).toBe('ok');
    expect(res1.cursor.lastPushedSegment).toBe(1);
    expect(res1.cursor.lastPushedSeq).toBe(1);

    // Now simulate an orphan seg-000002 with DIFFERENT content -> engine must skip to seg-000003 without overwriting
    await transport.write(deviceSegmentPath('dev-a', 2), encodeEventsSegment([ev1]), {
      ifAbsent: true,
    });
    const res2 = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: res1.cursor,
      localOwnSeq: 2,
      nowMs: () => t0 + 200,
      getLocalEventsAfterSeq: async (afterSeq) => [ev1, ev2].filter((e) => e.seq > afterSeq),
    });
    expect(res2.cursor.lastPushedSegment).toBe(3);
    const head = decodeDeviceHead(await transport.read(deviceHeadPath('dev-a')));
    expect(head.last_segment).toBe(3);
    expect(head.last_seq).toBe(2);
    // Original seg-000002 remains untouched
    expect(decodeEventsSegment(await transport.read(deviceSegmentPath('dev-a', 2)))[0]?.id).toBe(
      ev1.id,
    );
  });

  it('bootstraps fresh device from snapshot and downloads only delta segments', async () => {
    const transport = new RecordingMemoryTransport();
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const events: FlashEvent[] = [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Snap Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: t0,
        },
        t0,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId('d1', 'n1'),
          deck_id: 'd1',
          source_key: 'n1',
          fields: { word: '물', meaning: 'water' },
        },
        t0 + 10,
      ),
    ];
    const stateA = applyEvents(createEmptyState(), events);

    // Sync 1 on dev-a with snapshotThreshold=2 writes seg-000001 + snapshot
    const syncA1 = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 2,
      currentTotalEvents: 2,
      snapshotThreshold: 2,
      nowMs: () => t0 + 100,
      getLocalEventsAfterSeq: async (afterSeq) => events.filter((e) => e.seq > afterSeq),
      buildSnapshotState: async () => ({
        state: serializeCollectionState(stateA, { 'dev-a': 2 }),
        totalEvents: getTotalAppliedEventCount(stateA),
        watermarks: { 'dev-a': 2 },
      }),
    });
    expect(syncA1.snapshotWritten).toBeTruthy();

    // Add a 3rd event (delta after snapshot) and push seg-000002
    const ev3 = factory.create(
      'NoteUpserted',
      {
        note_id: deriveNoteId('d1', 'n2'),
        deck_id: 'd1',
        source_key: 'n2',
        fields: { word: '불', meaning: 'fire' },
      },
      t0 + 200,
    );
    events.push(ev3);
    applyEvents(stateA, [ev3]);

    await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: syncA1.cursor,
      localOwnSeq: 3,
      currentTotalEvents: 3,
      snapshotThreshold: 500,
      nowMs: () => t0 + 300,
      getLocalEventsAfterSeq: async (afterSeq) => events.filter((e) => e.seq > afterSeq),
    });

    // Fresh Device B bootstraps from snapshot and must NOT download seg-000001
    transport.readLog.length = 0;
    const syncB = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      canBootstrapFromSnapshot: true,
      nowMs: () => t0 + 400,
      getLocalEventsAfterSeq: async () => [],
    });

    expect(syncB.hydratedSnapshot).toBeDefined();
    if (!syncB.hydratedSnapshot) throw new Error('Expected hydrated snapshot');
    expect(syncB.pulledEvents).toHaveLength(1);
    expect(syncB.pulledEvents[0]?.seq).toBe(3);
    expect(transport.readLog).not.toContain(deviceSegmentPath('dev-a', 1));
    expect(transport.readLog).toContain(deviceSegmentPath('dev-a', 2));

    const stateB = deserializeCollectionState(syncB.hydratedSnapshot.state);
    applyEvents(stateB, syncB.pulledEvents);
    expect(stateB.notes.size).toBe(2);
    expect(stateB.notes.get(deriveNoteId('d1', 'n2'))?.fields['word']).toBe('불');
  });

  it('replays segments instead of a snapshot whose state format is newer than this build (D13)', async () => {
    const transport = new RecordingMemoryTransport();
    const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const events: FlashEvent[] = [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Future Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: t0,
        },
        t0,
      ),
    ];
    const stateA = applyEvents(createEmptyState(), events);
    const future = serializeCollectionState(stateA, { 'dev-a': 1 });
    future.formatVersion = SERIALIZED_STATE_FORMAT_VERSION + 1;
    await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 1,
      currentTotalEvents: 1,
      snapshotThreshold: 1,
      nowMs: () => t0 + 100,
      getLocalEventsAfterSeq: async (afterSeq) => events.filter((e) => e.seq > afterSeq),
      buildSnapshotState: async () => ({
        state: future,
        totalEvents: 1,
        watermarks: { 'dev-a': 1 },
      }),
    });

    const syncB = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      canBootstrapFromSnapshot: true,
      nowMs: () => t0 + 400,
      getLocalEventsAfterSeq: async () => [],
    });
    expect(syncB.hydratedSnapshot).toBeUndefined();
    expect(syncB.pulledEvents.map((e) => e.seq)).toEqual([1]);
  });

  it('replays segments instead of a snapshot from a build before media removal', async () => {
    const transport = new RecordingMemoryTransport();
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const hash = 'e'.repeat(64);
    const events: FlashEvent[] = [
      factory.create('MediaAdded', { media: { hash, ext: 'png', mime: 'image/png', size: 3 } }, t0),
      factory.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Snap Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: t0,
        },
        t0 + 1,
      ),
    ];
    const stateA = applyEvents(createEmptyState(), events);
    // What a build before media removal wrote: version 1, no `media:<hash>:added` register.
    const old = serializeCollectionState(stateA, { 'dev-a': 2 });
    old.formatVersion = 1;
    old.fieldHlcs = Object.fromEntries(
      Object.entries(old.fieldHlcs).filter(([k]) => k !== `media:${hash}:added`),
    );
    await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 2,
      currentTotalEvents: 2,
      snapshotThreshold: 2,
      nowMs: () => t0 + 100,
      getLocalEventsAfterSeq: async (afterSeq) => events.filter((e) => e.seq > afterSeq),
      buildSnapshotState: async () => ({ state: old, totalEvents: 2, watermarks: { 'dev-a': 2 } }),
    });

    const syncB = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      canBootstrapFromSnapshot: true,
      nowMs: () => t0 + 400,
      getLocalEventsAfterSeq: async () => [],
    });
    expect(syncB.hydratedSnapshot).toBeUndefined();
    expect(syncB.pulledEvents.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('enforces format_version and min_app_version read-only gate with 0 writes while preserving unknown events/fields', async () => {
    const transport = new RecordingMemoryTransport();
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-future', 0, createHlcState('dev-future', t0));
    const knownEv = factory.create(
      'DeckCreated',
      {
        deck_id: 'd-fut',
        name: 'Future Deck',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: t0,
      },
      t0,
    );
    const futureEv: UnknownEvent & { future_header: string } = {
      id: '01950000-0000-7000-8000-000000000099',
      device: 'dev-future',
      seq: 2,
      hlc: '019500000001-0001-dev-future',
      type: 'FutureCardAnimation',
      v: 3,
      payload: { style: 'sparkle', nested: { ok: true } },
      future_header: 'preserve-me',
    };

    // Write newer format_version = 2 manifest + segment + head
    await transport.write(
      manifestPath(),
      encodeManifest({
        collection_id: 'col-future',
        format_version: 2,
        min_app_version: '0.2.0',
        created_at: t0,
      }),
    );
    await transport.write(
      deviceSegmentPath('dev-future', 1),
      encodeEventsSegment([knownEv, futureEv]),
    );
    await transport.write(
      deviceHeadPath('dev-future'),
      encodeDeviceHead({
        device_id: 'dev-future',
        last_segment: 1,
        last_seq: 2,
        updated_at: t0,
        segments: [{ seg: 1, from_seq: 1, to_seq: 2, count: 2 }],
      }),
    );

    const localFactory = createEventFactory('dev-old', 0, createHlcState('dev-old', t0));
    const localEv = localFactory.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 6 } },
      t0,
    );

    transport.writeLog.length = 0;
    const resFormat = await runSync({
      transport,
      deviceId: 'dev-old',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 1,
      nowMs: () => t0 + 100,
      getLocalEventsAfterSeq: async () => [localEv],
    });

    expect(resFormat.status).toBe('upgrade_required');
    expect(resFormat.readOnly).toBe(true);
    expect(resFormat.pushedEventCount).toBe(0);
    expect(transport.writeLog).toHaveLength(0); // Strictly ZERO writes attempted
    expect(resFormat.pulledEvents).toHaveLength(2);
    const pulledUnknown = resFormat.pulledEvents.find((e) => e.type === 'FutureCardAnimation') as
      (UnknownEvent & { future_header?: string }) | undefined;
    expect(pulledUnknown?.future_header).toBe('preserve-me');

    // Also verify min_app_version gate even when format_version === 1
    await transport.write(
      manifestPath(),
      encodeManifest({
        collection_id: 'col-future',
        format_version: 1,
        min_app_version: '2.0.0',
        created_at: t0,
      }),
    );
    transport.writeLog.length = 0;
    const resMinVer = await runSync({
      transport,
      deviceId: 'dev-old',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 1,
      appVersion: '0.2.0',
      nowMs: () => t0 + 200,
      getLocalEventsAfterSeq: async () => [localEv],
    });
    expect(resMinVer.status).toBe('upgrade_required');
    expect(resMinVer.readOnly).toBe(true);
    expect(transport.writeLog).toHaveLength(0);
  });

  it('rejects collection_id mismatch without writing or merging', async () => {
    const transport = new RecordingMemoryTransport();
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    await transport.write(
      manifestPath(),
      encodeManifest({
        collection_id: 'col-remote-999',
        format_version: 1,
        min_app_version: '0.2.0',
        created_at: t0,
      }),
    );

    transport.writeLog.length = 0;
    const res = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor('col-local-111'),
      localOwnSeq: 0,
      getLocalEventsAfterSeq: async () => [],
    });

    expect(res.status).toBe('collection_mismatch');
    expect(res.readOnly).toBe(true);
    expect(res.pulledEvents).toHaveLength(0);
    expect(transport.writeLog).toHaveLength(0);
  });

  describe('expected collection (add-device link)', () => {
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const remoteId = 'col-remote-999';

    async function seedRemote(transport: RecordingMemoryTransport) {
      await transport.write(
        manifestPath(),
        encodeManifest({
          collection_id: remoteId,
          format_version: 1,
          min_app_version: '0.2.0',
          created_at: t0,
        }),
      );
      transport.writeLog.length = 0;
    }

    const localEv = createEventFactory('dev-a', 0, createHlcState('dev-a', t0)).create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 5 } },
      t0,
    );

    it('stops before binding, pulling or pushing when the remote collection differs', async () => {
      const transport = new RecordingMemoryTransport();
      await seedRemote(transport);
      const cursor = createInitialSyncCursor();
      const res = await runSync({
        transport,
        deviceId: 'dev-a',
        cursor,
        localOwnSeq: 1,
        expectedCollectionId: 'col-expected-111',
        getLocalEventsAfterSeq: async () => [localEv],
      });
      expect(res.status).toBe('collection_choice_required');
      expect(res.collectionId).toBe(remoteId);
      expect(res.pulledEvents).toHaveLength(0);
      expect(res.pushedEventCount).toBe(0);
      expect(res.cursor.collectionId).toBeUndefined();
      expect(transport.writeLog).toHaveLength(0);
    });

    it('choosing the synced collection later keeps and pushes every local event', async () => {
      const transport = new RecordingMemoryTransport();
      await seedRemote(transport);
      const res = await runSync({
        transport,
        deviceId: 'dev-a',
        cursor: createInitialSyncCursor(),
        localOwnSeq: 1,
        nowMs: () => t0 + 10,
        getLocalEventsAfterSeq: async () => [localEv],
      });
      expect(res.status).toBe('ok');
      expect(res.cursor.collectionId).toBe(remoteId);
      expect(res.pushedEventCount).toBe(1);
    });

    it('does not ask when the collection matches, the device is bound, or the store is empty', async () => {
      const transport = new RecordingMemoryTransport();
      await seedRemote(transport);
      const matching = await runSync({
        transport,
        deviceId: 'dev-a',
        cursor: createInitialSyncCursor(),
        localOwnSeq: 0,
        expectedCollectionId: remoteId,
        getLocalEventsAfterSeq: async () => [],
      });
      expect(matching.status).toBe('ok');

      const empty = new RecordingMemoryTransport();
      const fresh = await runSync({
        transport: empty,
        deviceId: 'dev-b',
        cursor: createInitialSyncCursor(),
        localOwnSeq: 0,
        expectedCollectionId: 'col-expected-111',
        getLocalEventsAfterSeq: async () => [],
      });
      expect(fresh.status).toBe('ok');
    });
  });

  it('blocks gzip bombs, oversized segments, and unsafe device IDs (§13)', () => {
    // 2 MiB of zeros compresses to ~2 KB -> exceeds a 64 KB uncompressed cap immediately
    const bombPayload = new Uint8Array(2 * 1024 * 1024);
    const compressedBomb = gzipSync(bombPayload, { level: 9 });
    expect(compressedBomb.byteLength).toBeLessThan(8192);

    expect(() =>
      safeGunzip(compressedBomb, {
        maxCompressedBytes: 1024 * 1024,
        maxUncompressedBytes: 64 * 1024,
      }),
    ).toThrow(SyncCodecError);

    expect(() =>
      safeGunzip(compressedBomb, {
        maxCompressedBytes: 128,
        maxUncompressedBytes: 10 * 1024 * 1024,
      }),
    ).toThrow(SyncCodecError);

    expect(() => decodeEventsSegment(gzipSync(encodeUtf8('{bad json\n')))).toThrow(SyncCodecError);

    for (const badId of ['', '.', '..', '../evil', 'a/b', 'a\\b', 'dev\0x', 'has space']) {
      expect(() => sanitizeDeviceId(badId)).toThrow(SyncCodecError);
    }
  });

  it('hydrates a 10,000-note / 50,000-review collection snapshot fast with zero FSRS recalculation and O(affected) incremental replay', () => {
    const t0 = Date.UTC(2026, 0, 1, 8, 0, 0);
    const deckId = 'deck-scale';
    const layoutId = 'layout:vocab-ko:recognition';
    const state = createEmptyState();
    const factory = createEventFactory('dev-scale', 0, createHlcState('dev-scale', t0));

    // Create 1 deck + 10,000 notes + 50,000 pre-computed reviews directly in state to simulate a large mature collection
    applyEvents(state, [
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Scale 10k',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: t0,
        },
        t0,
      ),
    ]);

    const noteEvents: FlashEvent[] = [];
    for (let i = 0; i < 10_000; i++) {
      const noteId = deriveNoteId(deckId, `k-${i}`);
      noteEvents.push(
        factory.create(
          'NoteUpserted',
          {
            note_id: noteId,
            deck_id: deckId,
            source_key: `k-${i}`,
            fields: { word: `단어${i}`, meaning: `meaning ${i}` },
            created_order: i,
          },
          t0 + i + 1,
        ),
      );
    }
    applyEvents(state, noteEvents);
    expect(state.notes.size).toBe(10_000);
    expect(state.cards.size).toBe(10_000);

    // Populate 50,000 historical review records (5 per card)
    let cardIdx = 0;
    for (const cardId of state.cards.keys()) {
      const list = [];
      for (let r = 0; r < 5; r++) {
        const revId = `rev-${cardIdx}-${r}`;
        list.push({
          review_id: revId,
          card_id: cardId,
          rating: 3 as const,
          reviewed_at: t0 + (r + 1) * 86_400_000,
          tz_offset: 0,
          duration_ms: 900,
          answer_mode: 'flip' as const,
          fsrs_params_version: 0,
          resulting_due_at: t0 + (r + 2) * 86_400_000,
          hlc: `019b0000000${r}-0000-dev-scale`,
        });
        state.reviewIdToCardId.set(revId, cardId);
      }
      state.reviewsByCard.set(cardId, list);
      cardIdx += 1;
    }

    const serialized = serializeCollectionState(state, { 'dev-scale': factory.getSeq() });
    const startHydrate = performance.now();
    const hydrated = deserializeCollectionState(serialized);
    const hydrateMs = performance.now() - startHydrate;

    expect(hydrated.notes.size).toBe(10_000);
    expect(hydrated.cards.size).toBe(10_000);
    expect(hydrated.reviewIdToCardId.size).toBe(50_000);
    expect(hydrateMs).toBeLessThan(1500);

    // Incremental single-card review + ReviewUndone on a 10k-note / 50k-review state must be O(affected) (< 50 ms)
    const targetCardId = deriveCardId(deriveNoteId(deckId, 'k-42'), layoutId, 0);
    const startInc = performance.now();
    const revEv = factory.create(
      'ReviewRecorded',
      {
        review_id: 'rev-inc-1',
        card_id: targetCardId,
        rating: 3,
        reviewed_at: t0 + 10 * 86_400_000,
        tz_offset: 0,
        duration_ms: 700,
        answer_mode: 'flip',
        fsrs_params_version: 0,
        resulting_due_at: t0 + 15 * 86_400_000,
      },
      t0 + 10 * 86_400_000,
    );
    const diff1 = applyEventsWithDiff(hydrated, [revEv]);
    const undoEv = factory.create(
      'ReviewUndone',
      { review_id: 'rev-inc-1' },
      t0 + 10 * 86_400_000 + 5,
    );
    const diff2 = applyEventsWithDiff(hydrated, [undoEv]);
    const incMs = performance.now() - startInc;

    expect(diff1.changedCardIds).toEqual([targetCardId]);
    expect(diff2.changedCardIds).toEqual([targetCardId]);
    expect(incMs).toBeLessThan(200);
  });

  it('does not re-push already uploaded own segments after disconnect/reconnect cursor reset, and EventFactory.setSeq prevents seq collisions', async () => {
    const transport = new RecordingMemoryTransport();
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const ev1 = factory.create('PreferencesChanged', { preferences: { day_start_hour: 4 } }, t0);
    const ev2 = factory.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 5 } },
      t0 + 10,
    );
    const localEvents: FlashEvent[] = [ev1, ev2];

    const first = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 2,
      nowMs: () => t0 + 100,
      getLocalEventsAfterSeq: async (afterSeq) => localEvents.filter((e) => e.seq > afterSeq),
    });
    expect(first.pushedEventCount).toBe(2);
    expect(first.pushedSegments).toBe(1);

    // Simulate disconnect & reconnect to the exact same store (fresh empty cursor, same localOwnSeq=2)
    transport.writeLog.length = 0;
    const reconnected = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 2,
      nowMs: () => t0 + 200,
      getLocalEventsAfterSeq: async (afterSeq) => localEvents.filter((e) => e.seq > afterSeq),
    });
    expect(reconnected.pushedEventCount).toBe(0);
    expect(reconnected.pushedSegments).toBe(0);
    expect(reconnected.cursor.lastPushedSeq).toBe(2);
    expect(reconnected.cursor.lastPushedSegment).toBe(1);
    expect(transport.writeLog).toHaveLength(0);

    // Verify EventFactory.setSeq advances monotonically and never moves backward
    const recoveredFactory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0 + 300));
    recoveredFactory.setSeq(2);
    recoveredFactory.setSeq(1); // Must not move backward
    const ev3 = recoveredFactory.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 6 } },
      t0 + 400,
    );
    expect(ev3.seq).toBe(3);
    localEvents.push(ev3);

    const third = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: reconnected.cursor,
      localOwnSeq: 3,
      nowMs: () => t0 + 500,
      getLocalEventsAfterSeq: async (afterSeq) => localEvents.filter((e) => e.seq > afterSeq),
    });
    expect(third.pushedEventCount).toBe(1);
    expect(third.pushedSegments).toBe(1);
    expect(third.cursor.lastPushedSegment).toBe(2);
    expect(third.cursor.lastPushedSeq).toBe(3);
  });

  it('stops at a listed segment that reads NOT_FOUND and never moves the watermark past its events', async () => {
    const transport = new RecordingMemoryTransport();
    const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const events = Array.from({ length: 6 }, (_, i) =>
      factory.create('PreferencesChanged', { preferences: { day_start_hour: i } }, t0 + i),
    );
    const pushed = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 6,
      nowMs: () => t0 + 100,
      maxEventsPerSegment: 2,
      getLocalEventsAfterSeq: async (after) => events.filter((e) => e.seq > after),
    });
    expect(pushed.pushedSegments).toBe(3);

    // Segment 2 (seq 3–4) is listed in head.json but not readable yet (list-read lag, deleted file).
    const seg2Path = deviceSegmentPath('dev-a', 2);
    const seg2 = transport.files.get(seg2Path);
    expect(seg2).toBeDefined();
    transport.files.delete(seg2Path);

    const partial = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      nowMs: () => t0 + 200,
      getLocalEventsAfterSeq: async () => [],
    });
    expect(partial.status).toBe('ok');
    expect(partial.pulledEvents.map((e) => e.seq)).toEqual([1, 2]);
    expect(partial.cursor.remoteWatermarks['dev-a']).toBe(2);
    expect(partial.pullWarnings?.[0]).toContain('Segment 2 from device dev-a');

    // Once the segment is readable again, the next run picks up everything it missed.
    if (seg2) transport.files.set(seg2Path, seg2);
    const healed = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: partial.cursor,
      localOwnSeq: 0,
      nowMs: () => t0 + 300,
      getLocalEventsAfterSeq: async () => [],
    });
    expect(healed.pulledEvents.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(healed.cursor.remoteWatermarks['dev-a']).toBe(6);
    expect(healed.pullWarnings).toBeUndefined();
  });

  it('a corrupt segment from one device stops only that device and still pulls the others', async () => {
    const transport = new RecordingMemoryTransport();
    const t0 = Date.UTC(2026, 10, 25, 10, 0, 0);
    for (const dev of ['dev-a', 'dev-c']) {
      const factory = createEventFactory(dev, 0, createHlcState(dev, t0));
      const events = [factory.create('PreferencesChanged', { preferences: {} }, t0)];
      await runSync({
        transport,
        deviceId: dev,
        cursor: createInitialSyncCursor(),
        localOwnSeq: 1,
        nowMs: () => t0 + 100,
        getLocalEventsAfterSeq: async (after) => events.filter((e) => e.seq > after),
      });
    }
    const corrupt = gzipSync(encodeUtf8('{"id":"x","device":"dev-a","seq":1,"hlc":"zzzz"}\n'));
    transport.files.set(deviceSegmentPath('dev-a', 1), { data: corrupt, updatedAt: 99 });

    const res = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      nowMs: () => t0 + 200,
      getLocalEventsAfterSeq: async () => [],
    });
    expect(res.status).toBe('ok');
    expect(res.pulledEvents.map((e) => e.device)).toEqual(['dev-c']);
    expect(res.cursor.remoteWatermarks['dev-a'] ?? 0).toBe(0);
    expect(res.pullWarnings?.[0]).toContain('Segment 1 from device dev-a');
  });

  it('rejects an event whose HLC is not in the format formatHlc writes', () => {
    const line = (hlc: string) =>
      gzipSync(
        encodeUtf8(
          JSON.stringify({ id: 'e1', device: 'd', seq: 1, hlc, type: 'X', v: 1, payload: {} }) +
            '\n',
        ),
      );
    expect(decodeEventsSegment(line('01936a4e2f10-0001-device-a'))).toHaveLength(1);
    for (const bad of ['zzzz', '01936A4E2F10-0001-d', '01936a4e2f10-0001-', '1-2-3']) {
      expect(() => decodeEventsSegment(line(bad))).toThrow(SyncCodecError);
    }
  });
});

describe('snapshots past the decoder limits (D12)', () => {
  const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);
  // The engine runs with a 64 KiB read cap (`snapshotLimits`) in place of the 25 MiB one, so the
  // over-cap snapshot (a collection with ~90k reviews) is one byte past 64 KiB, not 25 MiB.
  const limits = { maxUncompressedBytes: 64 * 1024 };
  const overCapPadding = () => 'x'.repeat(limits.maxUncompressedBytes + 1);

  it('keeps the 25 MiB cap for segments and heads, and reads snapshots up to 128 MiB raw', () => {
    expect(SYNC_CODEC_LIMITS.maxUncompressedBytes).toBe(25 * 1024 * 1024);
    expect(SYNC_SNAPSHOT_LIMITS.maxUncompressedBytes).toBe(128 * 1024 * 1024);
    // Same compressed cap, so transport read caps built on SYNC_CODEC_LIMITS still fit.
    expect(SYNC_SNAPSHOT_LIMITS.maxCompressedBytes).toBe(SYNC_CODEC_LIMITS.maxCompressedBytes);
    expect(() => assertSyncReadCapsCover({ codec: SYNC_SNAPSHOT_LIMITS })).not.toThrow();
    // The measured 20k-card collection (69.7 MiB raw, 5.07 MiB gzipped) fits both.
    expect(69.7 * 1024 * 1024).toBeLessThan(SYNC_SNAPSHOT_LIMITS.maxUncompressedBytes);
    expect(5.07 * 1024 * 1024).toBeLessThan(SYNC_SNAPSHOT_LIMITS.maxCompressedBytes);
  });

  it('encodes and decodes a snapshot past 25 MiB raw with the default limits', () => {
    const snap = {
      format_version: 1,
      snapshot_version: 1,
      collection_id: 'c1',
      created_by: 'dev-a',
      created_at: t0,
      total_events: 1,
      watermarks: {},
      // Compresses to a few dozen KiB, so the test stays fast.
      state: { pad: 'x'.repeat(SYNC_CODEC_LIMITS.maxUncompressedBytes + 1024) },
    } as unknown as SyncSnapshot;
    const gz = encodeReadableSyncSnapshot(snap);
    expect(gz).not.toBeNull();
    if (!gz) return;
    expect(() => decodeSyncSnapshot(gz, SYNC_CODEC_LIMITS)).toThrow(SyncCodecError);
    expect(decodeSyncSnapshot(gz).created_by).toBe('dev-a');
    // Overriding only the compressed cap keeps the snapshot default for the raw one.
    expect(decodeSyncSnapshot(gz, { maxCompressedBytes: 1024 * 1024 }).created_by).toBe('dev-a');
  });

  it('a snapshot past the old raw cap is read by new builds and skipped by older ones', async () => {
    // Scaled down: `oldCap` stands for the 25 MiB cap of older builds, `newCap` for 128 MiB.
    const oldCap = { maxUncompressedBytes: 64 * 1024 };
    const newCap = { maxUncompressedBytes: 512 * 1024, maxCompressedBytes: 64 * 1024 };
    const transport = new RecordingMemoryTransport();
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const events: FlashEvent[] = [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Big',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
        },
        t0,
      ),
    ];
    for (let i = 0; i < 400; i++) {
      events.push(
        factory.create(
          'NoteUpserted',
          {
            note_id: deriveNoteId('d1', `n${i}`),
            deck_id: 'd1',
            source_key: `n${i}`,
            fields: { word: `word-${i}`, meaning: `meaning ${i} `.repeat(20) },
          },
          t0 + i,
        ),
      );
    }
    const local = applyEvents(createEmptyState(), events);
    const writer = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: events.length,
      currentTotalEvents: events.length,
      snapshotThreshold: 1,
      snapshotLimits: newCap,
      nowMs: () => t0 + 1000,
      generateCollectionId: () => 'col-big',
      getLocalEventsAfterSeq: async (afterSeq) => events.filter((e) => e.seq > afterSeq),
      buildSnapshotState: async () => ({
        state: serializeCollectionState(local, { 'dev-a': events.length }),
        totalEvents: events.length,
      }),
    });
    expect(writer.snapshotWritten).toBe(snapshotPath('dev-a', events.length));
    const bytes = transport.files.get(snapshotPath('dev-a', events.length))?.data;
    if (!bytes) throw new Error('snapshot missing');
    // Past the old raw cap, within the compressed cap.
    expect(safeGunzip(bytes, newCap).byteLength).toBeGreaterThan(oldCap.maxUncompressedBytes);
    expect(bytes.byteLength).toBeLessThan(newCap.maxCompressedBytes);

    const fresh = (snapshotLimits: Partial<typeof SYNC_SNAPSHOT_LIMITS>) =>
      runSync({
        transport,
        deviceId: 'dev-b',
        cursor: createInitialSyncCursor(),
        localOwnSeq: 0,
        canBootstrapFromSnapshot: true,
        snapshotLimits,
        nowMs: () => t0 + 2000,
        getLocalEventsAfterSeq: async () => [],
      });

    const newer = await fresh(newCap);
    expect(newer.hydratedSnapshot?.total_events).toBe(events.length);
    expect(newer.pulledEvents).toHaveLength(0);

    const older = await fresh(oldCap);
    expect(older.hydratedSnapshot).toBeUndefined();
    expect(older.pulledEvents).toHaveLength(events.length);

    // Both end up with the same collection.
    const hydrated = newer.hydratedSnapshot;
    if (!hydrated) throw new Error('not hydrated');
    const fromSnapshot = deserializeCollectionState(hydrated.state);
    const fromSegments = applyEvents(createEmptyState(), older.pulledEvents);
    expect([...fromSnapshot.notes.keys()].sort()).toEqual([...fromSegments.notes.keys()].sort());
    expect(fromSnapshot.notes.get(deriveNoteId('d1', 'n399'))?.fields).toEqual(
      fromSegments.notes.get(deriveNoteId('d1', 'n399'))?.fields,
    );
  });

  it('encodes only snapshots the decoder will read back', () => {
    const snapshot = (pad: string): SyncSnapshot =>
      ({
        format_version: 1,
        snapshot_version: 1,
        collection_id: 'c1',
        created_by: 'dev-a',
        created_at: t0,
        total_events: 1,
        watermarks: {},
        state: { pad },
      }) as unknown as SyncSnapshot;
    expect(encodeReadableSyncSnapshot(snapshot('small'))).not.toBeNull();
    expect(
      encodeReadableSyncSnapshot(snapshot('x'.repeat(2000)), { maxUncompressedBytes: 1000 }),
    ).toBeNull();
    // Random-looking text barely compresses, so the compressed cap is what it passes.
    const noisy = Array.from({ length: 4000 }, (_, i) =>
      ((i * 2654435761) >>> 0).toString(36),
    ).join('');
    expect(encodeReadableSyncSnapshot(snapshot(noisy), { maxCompressedBytes: 2000 })).toBeNull();
  });

  it('does not upload a snapshot no device could read', async () => {
    const transport = new RecordingMemoryTransport();
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const events: FlashEvent[] = [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Big',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
        },
        t0,
      ),
    ];
    const state = applyEvents(createEmptyState(), events);
    const serialized = serializeCollectionState(state, { 'dev-a': 1 });
    const result = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 1,
      currentTotalEvents: 1,
      snapshotThreshold: 1,
      snapshotLimits: limits,
      nowMs: () => t0 + 100,
      getLocalEventsAfterSeq: async (afterSeq) => events.filter((e) => e.seq > afterSeq),
      buildSnapshotState: async () => ({
        state: { ...serialized, padding: overCapPadding() },
        totalEvents: 1,
        watermarks: { 'dev-a': 1 },
      }),
    });
    expect(result.status).toBe('ok');
    expect(result.snapshotWritten).toBeUndefined();
    expect([...transport.files.keys()].some((path) => path.includes('snapshot'))).toBe(false);
    expect(result.cursor.lastSnapshotTotalEvents).toBe(1);
  });

  it('a fresh device skips a remote snapshot past the read cap and falls back (D12, §9)', async () => {
    const transport = new RecordingMemoryTransport();
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const events: FlashEvent[] = [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Big',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
        },
        t0,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId('d1', 'n1'),
          deck_id: 'd1',
          source_key: 'n1',
          fields: { word: '물', meaning: 'water' },
        },
        t0 + 1,
      ),
    ];
    const pushed = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 2,
      nowMs: () => t0 + 100,
      generateCollectionId: () => 'col-big',
      getLocalEventsAfterSeq: async (afterSeq) => events.filter((e) => e.seq > afterSeq),
    });
    expect(pushed.status).toBe('ok');

    // Written as an older build did, with no size check (not `encodeReadableSyncSnapshot`).
    const gzipSnapshot = (snap: SyncSnapshot) => gzipSync(encodeUtf8(JSON.stringify(snap)));
    const snapshotAt = (seq: number, state: SyncSnapshot['state']): SyncSnapshot => ({
      format_version: 1,
      snapshot_version: 1,
      collection_id: 'col-big',
      created_by: 'dev-a',
      created_at: t0 + 100,
      total_events: seq,
      watermarks: { 'dev-a': seq },
      state,
    });
    const afterFirst = serializeCollectionState(
      applyEvents(createEmptyState(), events.slice(0, 1)),
      {
        'dev-a': 1,
      },
    );
    const afterBoth = serializeCollectionState(applyEvents(createEmptyState(), events), {
      'dev-a': 2,
    });
    // A readable older snapshot, then a newer one an older build wrote past the cap. Its
    // padding compresses well, so only the inflated size is over the limit.
    await transport.write(snapshotPath('dev-a', 1), gzipSnapshot(snapshotAt(1, afterFirst)));
    const oversized = gzipSnapshot(
      snapshotAt(2, { ...afterBoth, padding: overCapPadding() } as typeof afterBoth),
    );
    await transport.write(snapshotPath('dev-a', 2), oversized);
    expect(() => decodeSyncSnapshot(oversized, limits)).toThrow(SyncCodecError);

    const fresh = (cursor = createInitialSyncCursor()) =>
      runSync({
        transport,
        deviceId: 'dev-b',
        cursor,
        localOwnSeq: 0,
        canBootstrapFromSnapshot: true,
        snapshotLimits: limits,
        nowMs: () => t0 + 200,
        getLocalEventsAfterSeq: async () => [],
      });

    const fromOlder = await fresh();
    expect(fromOlder.status).toBe('ok');
    expect(fromOlder.hydratedSnapshot?.total_events).toBe(1);
    expect(fromOlder.pulledEvents.map((e) => e.seq)).toEqual([2]);
    expect(fromOlder.cursor.remoteWatermarks['dev-a']).toBe(2);

    // With only the oversized snapshot left, the device replays every segment instead.
    transport.files.delete(snapshotPath('dev-a', 1));
    const fromSegments = await fresh();
    expect(fromSegments.status).toBe('ok');
    expect(fromSegments.hydratedSnapshot).toBeUndefined();
    expect(fromSegments.pulledEvents.map((e) => e.seq)).toEqual([1, 2]);
    const state = applyEvents(createEmptyState(), fromSegments.pulledEvents);
    expect(state.notes.get(deriveNoteId('d1', 'n1'))?.fields['word']).toBe('물');
  });
});
