import { describe, expect, it } from 'vitest';
import { createEventFactory } from '../src/events/replay.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import {
  decodeDeviceHead,
  decodeEventsSegment,
  deviceHeadPath,
  deviceSegmentPath,
  encodeDeviceHead,
} from '../src/sync/codec.ts';
import { runSync, type SyncEngineOptions } from '../src/sync/engine.ts';
import { createInitialSyncCursor, type SyncCursorState } from '../src/sync/types.ts';
import { MemorySyncTransport } from './helpers/memory-sync-transport.ts';

// `head.json` keeps one range per listed segment. Compaction rewrites the head's tail of small
// segments as full ones. The head format and the pull path are unchanged, so `runSync` as a
// reader is exactly what older builds run; these tests use it as the older reader too, and
// `maxUnpackedHeadSegments: Infinity` as the older writer.

const t0 = Date.UTC(2026, 10, 27, 9, 0, 0);
const FULL = 4; // maxEventsPerSegment
const MAX_UNPACKED = 3; // maxUnpackedHeadSegments

function makeEvents(count: number): FlashEvent[] {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
  const events: FlashEvent[] = [
    factory.create(
      'DeckCreated',
      { deck_id: 'd1', name: 'K', note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, language: 'ko' },
      t0,
    ),
  ];
  for (let i = 1; i < count; i++) {
    events.push(
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId('d1', `n${i}`),
          deck_id: 'd1',
          source_key: `n${i}`,
          fields: { word: `w${i}`, meaning: `m${i}` },
        },
        t0 + i,
      ),
    );
  }
  return events;
}

/** Device A, holding `events[0..upTo)` locally, pushes them. */
function pushA(
  transport: MemorySyncTransport,
  cursor: SyncCursorState,
  events: readonly FlashEvent[],
  upTo: number,
  extra: Partial<SyncEngineOptions> = {},
) {
  const local = events.slice(0, upTo);
  return runSync({
    transport,
    deviceId: 'dev-a',
    cursor,
    localOwnSeq: upTo,
    maxEventsPerSegment: FULL,
    maxUnpackedHeadSegments: MAX_UNPACKED,
    nowMs: () => t0 + 1000 + upTo,
    generateCollectionId: () => 'col-1',
    getLocalEventsAfterSeq: async (after) => local.filter((e) => e.seq > after),
    ...extra,
  });
}

function pullB(transport: MemorySyncTransport, cursor = createInitialSyncCursor()) {
  return runSync({
    transport,
    deviceId: 'dev-b',
    cursor,
    localOwnSeq: 0,
    nowMs: () => t0 + 5000,
    getLocalEventsAfterSeq: async () => [],
  });
}

async function readHead(transport: MemorySyncTransport) {
  return decodeDeviceHead(await transport.read(deviceHeadPath('dev-a')));
}

/** Every listed segment holds exactly the events its range claims, and the ranges tile 1..last. */
async function expectHeadConsistent(transport: MemorySyncTransport, lastSeq: number) {
  const head = await readHead(transport);
  const segments = head.segments ?? [];
  let next = 1;
  let prevSeg = 0;
  for (const range of segments) {
    expect(range.seg).toBeGreaterThan(prevSeg);
    expect(range.from_seq).toBe(next);
    const evs = decodeEventsSegment(await transport.read(deviceSegmentPath('dev-a', range.seg)));
    expect(evs.map((e) => e.seq)).toEqual(
      Array.from({ length: range.count }, (_, i) => range.from_seq + i),
    );
    expect(range.to_seq).toBe(range.from_seq + range.count - 1);
    next = range.to_seq + 1;
    prevSeg = range.seg;
  }
  expect(next - 1).toBe(lastSeq);
  expect(head.last_seq).toBe(lastSeq);
  return head;
}

describe('head.json segments compaction', () => {
  it('folds the tail of small segments into full ones and keeps the head bounded', async () => {
    const transport = new MemorySyncTransport();
    const events = makeEvents(40);
    let cursor = createInitialSyncCursor();
    for (let n = 1; n <= events.length; n++) {
      const res = await pushA(transport, cursor, events, n);
      expect(res.status).toBe('ok');
      expect(res.pushedEventCount).toBe(1);
      cursor = res.cursor;
      const head = await expectHeadConsistent(transport, n);
      const segments = head.segments ?? [];
      const full = segments.filter((s) => s.count >= FULL).length;
      // The check runs before a push, so the push itself can add one more small range.
      expect(segments.length - full).toBeLessThanOrEqual(MAX_UNPACKED + 1);
      expect(cursor.pushedSegments).toEqual(segments);
    }
    expect((await readHead(transport)).segments?.length).toBeLessThan(15);

    // Without compaction the same pushes list one range per push.
    const plain = new MemorySyncTransport();
    let plainCursor = createInitialSyncCursor();
    for (let n = 1; n <= events.length; n++) {
      const res = await pushA(plain, plainCursor, events, n, { maxUnpackedHeadSegments: Infinity });
      plainCursor = res.cursor;
    }
    expect((await readHead(plain)).segments).toHaveLength(40);
  });

  it('a reader part-way through the folded ranges still gets every event exactly once', async () => {
    const transport = new MemorySyncTransport();
    const events = makeEvents(30);
    let cursorA = createInitialSyncCursor();
    let cursorB = createInitialSyncCursor();
    const seenByB: number[] = [];
    // B syncs at uneven points, so its watermark lands inside ranges that later get folded.
    const bSyncsAt = new Set([2, 3, 7, 11, 12, 19, 26, 30]);
    for (let n = 1; n <= events.length; n++) {
      cursorA = (await pushA(transport, cursorA, events, n)).cursor;
      if (bSyncsAt.has(n)) {
        const pulled = await pullB(transport, cursorB);
        expect(pulled.pullWarnings).toBeUndefined();
        seenByB.push(...pulled.pulledEvents.map((e) => e.seq));
        cursorB = pulled.cursor;
      }
    }
    expect(seenByB).toEqual(events.map((e) => e.seq));

    // A fresh reader pulls everything from the compacted head.
    const fresh = await pullB(transport);
    expect(fresh.pulledEvents.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it('a reader that hydrated a snapshot fetches only what is past its watermark', async () => {
    const transport = new MemorySyncTransport();
    const events = makeEvents(25);
    let cursorA = createInitialSyncCursor();
    for (let n = 1; n <= events.length; n++) {
      cursorA = (await pushA(transport, cursorA, events, n)).cursor;
    }
    const cursor = { ...createInitialSyncCursor('col-1'), remoteWatermarks: { 'dev-a': 21 } };
    const res = await pullB(transport, cursor);
    expect(res.pulledEvents.map((e) => e.seq)).toEqual([22, 23, 24, 25]);
  });

  it('compacts a head an older build wrote, on its next push, from a fresh cursor', async () => {
    const transport = new MemorySyncTransport();
    const events = makeEvents(12);
    // An older build: no compaction, one range per push.
    let cursor = createInitialSyncCursor();
    for (let n = 1; n <= 10; n++) {
      const res = await pushA(transport, cursor, events, n, { maxUnpackedHeadSegments: Infinity });
      cursor = res.cursor;
    }
    expect((await readHead(transport)).segments).toHaveLength(10);
    const reader = await pullB(transport);
    expect(reader.pulledEvents).toHaveLength(10);

    // The upgraded build reconnects with a cleared cursor; it adopts the head's ranges.
    const upgraded = await pushA(transport, createInitialSyncCursor(), events, 11);
    expect(upgraded.pushedEventCount).toBe(1);
    const head = await expectHeadConsistent(transport, 11);
    expect(head.segments?.map((s) => s.count)).toEqual([4, 4, 3]);
    // Segment numbers keep rising: the old files stay, unlisted.
    expect(head.segments?.[0]?.seg).toBe(11);
    expect(head.last_segment).toBe(13);
    expect(transport.files.has(deviceSegmentPath('dev-a', 1))).toBe(true);

    // The reader that synced against the old head continues against the new one.
    const next = await pullB(transport, reader.cursor);
    expect(next.pulledEvents.map((e) => e.seq)).toEqual([11]);

    // An older build pushing on top of a compacted head appends a range as before.
    const older = await pushA(transport, upgraded.cursor, events, 12, {
      maxUnpackedHeadSegments: Infinity,
    });
    expect(older.pushedEventCount).toBe(1);
    await expectHeadConsistent(transport, 12);
    expect((await pullB(transport, next.cursor)).pulledEvents.map((e) => e.seq)).toEqual([12]);
  });

  it('keeps the long head when local storage lacks a folded event', async () => {
    const transport = new MemorySyncTransport();
    const events = makeEvents(8);
    let cursor = createInitialSyncCursor();
    for (let n = 1; n <= 4; n++) {
      cursor = (await pushA(transport, cursor, events, n)).cursor;
    }
    expect((await readHead(transport)).segments).toHaveLength(4);
    // Seq 2 is gone locally (say a pruned log): pushing seq 5 must not fold.
    const res = await pushA(transport, cursor, events, 5, {
      getLocalEventsAfterSeq: async (after) =>
        events.slice(0, 5).filter((e) => e.seq > after && e.seq !== 2),
    });
    expect(res.pushedEventCount).toBe(1);
    const head = await expectHeadConsistent(transport, 5);
    expect(head.segments).toHaveLength(5);
    expect((await pullB(transport)).pulledEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a cursor not saved after a push neither drops that push from the head nor folds it away', async () => {
    const transport = new MemorySyncTransport();
    const events = makeEvents(8);
    let cursor = createInitialSyncCursor();
    for (let n = 1; n <= 4; n++) {
      cursor = (await pushA(transport, cursor, events, n)).cursor;
    }
    // This push writes head.json (and compacts), but the app exits before saving its cursor.
    await pushA(transport, cursor, events, 5);
    await expectHeadConsistent(transport, 5);

    // The next sync starts from the cursor saved after seq 4.
    const res = await pushA(transport, cursor, events, 6);
    expect(res.pushedEventCount).toBe(1);
    await expectHeadConsistent(transport, 6);
    expect(res.cursor.pushedSegments).toEqual((await readHead(transport)).segments);
    expect((await pullB(transport)).pulledEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a crash after the folded segments are written but before head.json recovers', async () => {
    for (const retryUpTo of [5, 6]) {
      const transport = new MemorySyncTransport();
      const events = makeEvents(8);
      let cursor = createInitialSyncCursor();
      for (let n = 1; n <= 4; n++) {
        cursor = (await pushA(transport, cursor, events, n)).cursor;
      }
      const reader = await pullB(transport);
      // The compacting push dies at the head write: its new segments stay, unlisted.
      const write = transport.write.bind(transport);
      transport.write = async (path, data, opts) => {
        if (path === deviceHeadPath('dev-a')) throw new Error('crash');
        return write(path, data, opts);
      };
      await expect(pushA(transport, cursor, events, 5)).rejects.toThrow('crash');
      transport.write = write;
      expect((await readHead(transport)).segments).toHaveLength(4);
      const filesAfterCrash = transport.files.size;

      // Same events again: the orphans are adopted. One more event: the last chunk differs,
      // so that one moves to a fresh segment number.
      const res = await pushA(transport, cursor, events, retryUpTo);
      expect(res.status).toBe('ok');
      const head = await expectHeadConsistent(transport, retryUpTo);
      expect(head.segments?.map((s) => s.count)).toEqual(retryUpTo === 5 ? [4, 1] : [4, 2]);
      // No new file when both orphans are adopted; one when the second chunk needs a new number.
      expect(transport.files.size - filesAfterCrash).toBe(retryUpTo === 5 ? 0 : 1);
      const next = await pullB(transport, reader.cursor);
      expect(next.pulledEvents.map((e) => e.seq)).toEqual(retryUpTo === 5 ? [5] : [5, 6]);
    }
  });

  it('leaves a head whose ranges overlap alone', async () => {
    const transport = new MemorySyncTransport();
    const events = makeEvents(6);
    let cursor = createInitialSyncCursor();
    for (let n = 1; n <= 4; n++) {
      cursor = (await pushA(transport, cursor, events, n)).cursor;
    }
    const head = await readHead(transport);
    const [a, b, c, d] = head.segments ?? [];
    if (!a || !b || !c || !d) throw new Error('expected four ranges');
    const overlapping = { ...head, segments: [a, { ...b, to_seq: 3 }, c, d] };
    await transport.write(deviceHeadPath('dev-a'), encodeDeviceHead(overlapping));
    const res = await pushA(transport, cursor, events, 5);
    expect((await readHead(transport)).segments).toHaveLength(5);
    expect(res.pushedSegments).toBe(1);
  });
});
