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
import type { FlashEvent, UnknownEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId, encodeUtf8 } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import {
  decodeDeviceHead,
  decodeEventsSegment,
  deviceHeadPath,
  deviceSegmentPath,
  encodeDeviceHead,
  encodeEventsSegment,
  encodeManifest,
  manifestPath,
  safeGunzip,
  sanitizeDeviceId,
  SyncCodecError,
} from '../src/sync/codec.ts';
import { runSync } from '../src/sync/engine.ts';
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
});
