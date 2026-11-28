import { describe, expect, it } from 'vitest';
import {
  assertSyncReadCapsCover,
  assertSyncReadSize,
  createInitialSyncCursor,
  deviceHeadPath,
  deviceSegmentPath,
  manifestPath,
  mediaObjectPath,
  snapshotPath,
  SYNC_CODEC_LIMITS,
  SYNC_MEDIA_LIMITS,
  SYNC_READ_CAPS,
  SyncCodecError,
  syncReadCap,
  syncReadCapsFor,
  SyncReadTooLargeError,
} from '../src/index.ts';
import { runSync } from '../src/sync/engine.ts';

const untouchedTransport = {
  list: async () => {
    throw new Error('transport used');
  },
  read: async () => {
    throw new Error('transport used');
  },
  write: async () => {
    throw new Error('transport used');
  },
};

function runWith(overrides: {
  maxMediaBlobBytes?: number;
  snapshotLimits?: Partial<typeof SYNC_CODEC_LIMITS>;
}) {
  return runSync({
    transport: untouchedTransport,
    deviceId: 'dev-a',
    cursor: createInitialSyncCursor(),
    localOwnSeq: 0,
    getLocalEventsAfterSeq: async () => [],
    ...overrides,
  });
}

describe('sync read caps', () => {
  it('are derived from the limits the engine reads under by default', () => {
    // Fails if anyone hand-writes the caps again and they drift from the codec or media limits.
    expect(SYNC_READ_CAPS).toEqual(syncReadCapsFor());
    expect(SYNC_READ_CAPS).toEqual(
      syncReadCapsFor({
        codec: SYNC_CODEC_LIMITS,
        maxMediaBlobBytes: SYNC_MEDIA_LIMITS.maxMediaBlobBytes,
      }),
    );
    expect(SYNC_READ_CAPS.head).toBeGreaterThanOrEqual(SYNC_CODEC_LIMITS.maxUncompressedBytes);
    expect(SYNC_READ_CAPS.segment).toBeGreaterThanOrEqual(SYNC_CODEC_LIMITS.maxCompressedBytes);
    expect(SYNC_READ_CAPS.snapshot).toBeGreaterThanOrEqual(SYNC_CODEC_LIMITS.maxCompressedBytes);
    expect(SYNC_READ_CAPS.media).toBeGreaterThanOrEqual(SYNC_MEDIA_LIMITS.maxMediaBlobBytes);
  });

  it('give each sync path its kind and cap', () => {
    expect(syncReadCap(manifestPath())).toEqual({ kind: 'head', maxBytes: SYNC_READ_CAPS.head });
    expect(syncReadCap(deviceHeadPath('dev-a')).kind).toBe('head');
    expect(syncReadCap(deviceSegmentPath('dev-a', 3)).kind).toBe('segment');
    expect(syncReadCap(snapshotPath('dev-a', 9)).kind).toBe('snapshot');
    expect(syncReadCap(mediaObjectPath('ab'.repeat(32), 'png')).kind).toBe('media');
    expect(syncReadCap('sync/v1/unknown.bin').kind).toBe('snapshot');
  });

  it('refuse a size past the cap with a SyncCodecError naming the file', () => {
    const path = deviceSegmentPath('dev-a', 1);
    expect(() => assertSyncReadSize('Test', path, SYNC_READ_CAPS.segment)).not.toThrow();
    let caught: unknown;
    try {
      assertSyncReadSize('Test', path, SYNC_READ_CAPS.segment + 1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SyncReadTooLargeError);
    expect(caught).toBeInstanceOf(SyncCodecError);
    expect(caught).toMatchObject({ path, kind: 'segment', maxBytes: SYNC_READ_CAPS.segment });
    expect((caught as Error).message).toContain(`${SYNC_READ_CAPS.segment + 1} >`);
  });

  it('cover the default limits and any lower override', () => {
    expect(() => assertSyncReadCapsCover({})).not.toThrow();
    expect(() =>
      assertSyncReadCapsCover({ codec: { maxCompressedBytes: 1024 }, maxMediaBlobBytes: 4 }),
    ).not.toThrow();
  });

  it('refuse any snapshot or media limit override above its default', () => {
    expect(() =>
      assertSyncReadCapsCover({ maxMediaBlobBytes: SYNC_MEDIA_LIMITS.maxMediaBlobBytes + 1 }),
    ).toThrow(RangeError);
    expect(() =>
      assertSyncReadCapsCover({
        codec: { maxCompressedBytes: SYNC_CODEC_LIMITS.maxCompressedBytes + 1 },
      }),
    ).toThrow(/snapshot limit override/);
  });

  it('make runSync reject an override past them before touching the transport', async () => {
    await expect(
      runWith({ maxMediaBlobBytes: SYNC_MEDIA_LIMITS.maxMediaBlobBytes * 3 }),
    ).rejects.toThrow(/media limit override/);
    await expect(
      runWith({ snapshotLimits: { maxCompressedBytes: SYNC_CODEC_LIMITS.maxCompressedBytes * 2 } }),
    ).rejects.toThrow(/snapshot limit override/);
    // A lower override (what the tests use) passes the guard and reaches the transport.
    await expect(runWith({ maxMediaBlobBytes: 4 })).rejects.toThrow('transport used');
  });
});
