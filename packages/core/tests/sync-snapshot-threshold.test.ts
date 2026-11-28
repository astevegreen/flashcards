import { describe, expect, it } from 'vitest';
import { createEmptyState } from '../src/events/replay.ts';
import { serializeCollectionState } from '../src/events/snapshot.ts';
import { effectiveSnapshotThreshold, runSync, type SyncEngineOptions } from '../src/sync/engine.ts';
import { createInitialSyncCursor, type SyncCursorState } from '../src/sync/types.ts';
import { MemorySyncTransport } from './helpers/memory-sync-transport.ts';

const t0 = Date.UTC(2026, 10, 27, 12, 0, 0);

describe('effectiveSnapshotThreshold', () => {
  it('is the floor until the last snapshot is big enough to raise it', () => {
    expect(effectiveSnapshotThreshold(500, undefined, 1024)).toBe(500);
    expect(effectiveSnapshotThreshold(500, 0, 1024)).toBe(500);
    expect(effectiveSnapshotThreshold(500, 500 * 1024, 1024)).toBe(500);
    expect(effectiveSnapshotThreshold(500, 500 * 1024 + 1, 1024)).toBe(501);
    // A 20k-card collection: 5.07 MiB gzipped.
    expect(effectiveSnapshotThreshold(500, Math.round(5.07 * 1024 * 1024), 1024)).toBe(5192);
  });

  it('ignores a bytes-per-event that is not positive', () => {
    expect(effectiveSnapshotThreshold(500, 10 * 1024 * 1024, 0)).toBe(500);
    expect(effectiveSnapshotThreshold(500, 10 * 1024 * 1024, Number.NaN)).toBe(500);
  });
});

describe('snapshot threshold scales with the last snapshot', () => {
  const state = serializeCollectionState(createEmptyState(), {});

  function sync(
    transport: MemorySyncTransport,
    deviceId: string,
    cursor: SyncCursorState,
    totalEvents: number,
    extra: Partial<SyncEngineOptions> = {},
  ) {
    return runSync({
      transport,
      deviceId,
      cursor,
      localOwnSeq: 0,
      currentTotalEvents: totalEvents,
      snapshotThreshold: 2,
      // One byte per event: the threshold is the last snapshot's gzipped size in events.
      snapshotBytesPerEvent: 1,
      nowMs: () => t0 + totalEvents,
      generateCollectionId: () => 'col-1',
      getLocalEventsAfterSeq: async () => [],
      buildSnapshotState: async () => ({ state, totalEvents }),
      ...extra,
    });
  }

  it('waits for as many new events as the last snapshot had bytes', async () => {
    const transport = new MemorySyncTransport();
    const first = await sync(transport, 'dev-a', createInitialSyncCursor(), 2);
    expect(first.snapshotWritten).toBeTruthy();
    const bytes = first.cursor.lastSnapshotBytes;
    if (!first.snapshotWritten || bytes === undefined) throw new Error('expected a snapshot');
    expect(bytes).toBe(transport.files.get(first.snapshotWritten)?.data.byteLength);
    expect(bytes).toBeGreaterThan(2);

    // Past the 2-event floor but short of the scaled threshold: no snapshot.
    const early = await sync(transport, 'dev-a', first.cursor, 2 + bytes - 1);
    expect(early.snapshotWritten).toBeUndefined();
    expect(early.cursor.lastSnapshotTotalEvents).toBe(2);

    const due = await sync(transport, 'dev-a', early.cursor, 2 + bytes);
    expect(due.snapshotWritten).toBeTruthy();
    expect(due.cursor.lastSnapshotTotalEvents).toBe(2 + bytes);

    // A cursor from an older build has no size: the floor applies.
    const { lastSnapshotBytes: _dropped, ...legacy } = due.cursor;
    const legacyRun = await sync(transport, 'dev-a', legacy, 2 + bytes + 2);
    expect(legacyRun.snapshotWritten).toBeTruthy();
  });

  it('a device that hydrated a snapshot takes its size', async () => {
    const transport = new MemorySyncTransport();
    const written = await sync(transport, 'dev-a', createInitialSyncCursor(), 2);
    if (!written.snapshotWritten) throw new Error('expected a snapshot');
    const bytes = transport.files.get(written.snapshotWritten)?.data.byteLength;

    const hydrated = await sync(transport, 'dev-b', createInitialSyncCursor(), 0, {
      canBootstrapFromSnapshot: true,
      buildSnapshotState: async () => null,
    });
    expect(hydrated.hydratedSnapshot).toBeDefined();
    expect(hydrated.cursor.lastSnapshotBytes).toBe(bytes);
  });

  it('a snapshot over the cap is never uploaded, but its size scales the next try', async () => {
    const transport = new MemorySyncTransport();
    const capped = { snapshotLimits: { maxUncompressedBytes: 10 } };
    const res = await sync(transport, 'dev-a', createInitialSyncCursor(), 2, capped);
    expect(res.snapshotWritten).toBeUndefined();
    expect([...transport.files.keys()].some((p) => p.includes('snapshots/'))).toBe(false);
    // Refused before gzip: the raw JSON size.
    const bytes = res.cursor.lastSnapshotBytes;
    if (bytes === undefined) throw new Error('expected the attempted size');
    expect(bytes).toBeGreaterThan(10);
    expect(res.cursor.lastSnapshotTotalEvents).toBe(2);

    let built = 0;
    const counting = {
      ...capped,
      buildSnapshotState: async () => {
        built++;
        return { state, totalEvents: 2 + bytes };
      },
    };
    // Past the 2-event floor but short of the scaled interval: not even built.
    await sync(transport, 'dev-a', res.cursor, 2 + bytes - 1, counting);
    expect(built).toBe(0);
    const again = await sync(transport, 'dev-a', res.cursor, 2 + bytes, counting);
    expect(built).toBe(1);
    expect(again.snapshotWritten).toBeUndefined();
    expect([...transport.files.keys()].some((p) => p.includes('snapshots/'))).toBe(false);
  });

  it('a snapshot another run already wrote at the same path still records its size', async () => {
    const transport = new MemorySyncTransport();
    const first = await sync(transport, 'dev-a', createInitialSyncCursor(), 2);
    if (!first.snapshotWritten) throw new Error('expected a snapshot');
    // The same snapshot again from a cursor saved before it: the write finds the file.
    const raced = await sync(transport, 'dev-a', createInitialSyncCursor(), 2);
    expect(raced.snapshotWritten).toBeUndefined();
    expect(raced.cursor.lastSnapshotBytes).toBe(first.cursor.lastSnapshotBytes);
    expect(raced.cursor.lastSnapshotTotalEvents).toBe(2);
  });
});
