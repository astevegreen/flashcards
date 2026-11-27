import {
  createEventFactory,
  createHlcState,
  createInitialSyncCursor,
  deviceHeadPath,
  deviceSegmentPath,
  manifestPath,
  mediaObjectPath,
  snapshotPath,
  SYNC_CODEC_LIMITS,
  SYNC_MEDIA_LIMITS,
  SyncCodecError,
  type FlashEvent,
  type SyncMediaStore,
} from '@flash/core';
import { sha256Hex } from '@flash/core/sources';
import { runSync } from '@flash/core/sync';
import type { SyncTransport } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import { DropboxAppFolderTransport } from '../src/sync/dropbox-transport.ts';
import { GoogleDriveAppDataTransport } from '../src/sync/google-drive-transport.ts';
import { OneDriveAppFolderTransport } from '../src/sync/onedrive-transport.ts';
import {
  SYNC_READ_CAPS,
  syncFileKind,
  SyncReadTooLargeError,
  type SyncFileKind,
} from '../src/sync/sync-read-caps.ts';
import { FakeDriveServer } from './fakes/fake-drive.ts';
import { FakeDropboxServer } from './fakes/fake-dropbox.ts';
import { FAKE_DOWNLOAD_ORIGIN, FakeGraphServer } from './fakes/fake-graph.ts';
import { declaredBody, streamedBody } from './helpers/oversized-body.ts';

const MiB = 1024 * 1024;
const CHUNK = MiB;
const SNAPSHOT = snapshotPath('dev-a', 42);
const HEAD = deviceHeadPath('dev-a');
const SEGMENT = deviceSegmentPath('dev-a', 1);
const MEDIA = mediaObjectPath('ab'.repeat(32), 'png');
const PATHS: Record<SyncFileKind, string> = {
  head: HEAD,
  segment: SEGMENT,
  snapshot: SNAPSHOT,
  media: MEDIA,
};

/** Replaces a file download's reply; every other request goes to the fake server. */
type DownloadOverride = (() => Response) | undefined;

interface Harness {
  transport: SyncTransport;
  setDownload(override: DownloadOverride): void;
}

function wrap(
  fakeFetch: typeof fetch,
  isDownload: (url: URL, init?: RequestInit) => boolean,
): { fetchImpl: typeof fetch; setDownload(o: DownloadOverride): void } {
  let override: DownloadOverride;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (override && isDownload(url, init)) return override();
    return fakeFetch(input, init);
  };
  return {
    fetchImpl,
    setDownload: (o) => {
      override = o;
    },
  };
}

function googleDrive(): Harness {
  const { fetchImpl, setDownload } = wrap(
    new FakeDriveServer().fetch,
    (url, init) =>
      (init?.method ?? 'GET') === 'GET' &&
      url.pathname.startsWith('/drive/v3/files/') &&
      url.searchParams.get('alt') === 'media',
  );
  const transport = new GoogleDriveAppDataTransport({
    auth: {
      isConfigured: () => true,
      isConnected: async () => true,
      getSession: async () => null,
      getValidAccessToken: async () => 'token',
      signIn: async () => null,
      handleRedirectCallback: async () => null,
      signOut: async () => {},
    },
    fetchImpl,
  });
  return { transport, setDownload };
}

function dropbox(): Harness {
  const { fetchImpl, setDownload } = wrap(new FakeDropboxServer().fetch, (url) =>
    url.pathname.endsWith('/files/download'),
  );
  const transport = new DropboxAppFolderTransport({
    getAccessToken: async () => 'token',
    fetchImpl,
    sleep: async () => {},
    random: () => 0,
  });
  return { transport, setDownload };
}

function oneDrive(): Harness {
  const { fetchImpl, setDownload } = wrap(
    new FakeGraphServer().fetch,
    (url) => url.origin === FAKE_DOWNLOAD_ORIGIN,
  );
  const transport = new OneDriveAppFolderTransport({
    auth: { getValidAccessToken: vi.fn(async () => 'graph-token-1') },
    fetchImpl,
    sleep: async () => {},
    random: () => 0.5,
  });
  return { transport, setDownload };
}

/** Serves `replies[path]` instead of the stored file for each read of that path. */
function overrideReads(harness: Harness, replies: Record<string, () => Response>): void {
  const real = harness.transport.read.bind(harness.transport);
  vi.spyOn(harness.transport, 'read').mockImplementation(async (path) => {
    harness.setDownload(replies[path]);
    return real(path);
  });
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

/** A head.json of a device that pushed `ranges` single-event segments, never pruned. */
function longLivedHead(ranges: number): Uint8Array {
  const segments = Array.from({ length: ranges }, (_, i) => ({
    seg: i + 1,
    from_seq: i * 3 + 1_000_000,
    to_seq: i * 3 + 1_000_002,
    count: 3,
  }));
  return new TextEncoder().encode(
    JSON.stringify({
      device_id: 'dev-a',
      last_segment: ranges,
      last_seq: ranges * 3 + 1_000_002,
      updated_at: Date.UTC(2036, 0, 1),
      segments,
    }),
  );
}

describe('sync file kinds and caps', () => {
  it('classifies every sync path the engine reads', () => {
    expect(syncFileKind(manifestPath())).toBe('head');
    expect(syncFileKind(HEAD)).toBe('head');
    expect(syncFileKind(SEGMENT)).toBe('segment');
    expect(syncFileKind(SNAPSHOT)).toBe('snapshot');
    expect(syncFileKind(MEDIA)).toBe('media');
    // An unknown path gets the largest cap rather than the smallest.
    expect(syncFileKind('sync/v1/other.bin')).toBe('snapshot');
  });

  it('sits at or above what the codec and the media check read, so no readable file is refused', () => {
    expect(SYNC_READ_CAPS.head).toBe(SYNC_CODEC_LIMITS.maxUncompressedBytes);
    expect(SYNC_READ_CAPS.segment).toBeGreaterThan(SYNC_CODEC_LIMITS.maxCompressedBytes);
    expect(SYNC_READ_CAPS.snapshot).toBeGreaterThan(SYNC_CODEC_LIMITS.maxCompressedBytes);
    expect(SYNC_READ_CAPS.media).toBeGreaterThan(SYNC_MEDIA_LIMITS.maxMediaBlobBytes);
  });

  it('is a SyncCodecError, so the engine treats it as it treats a file past the codec limit', () => {
    const err = new SyncReadTooLargeError('Dropbox', SEGMENT, 'segment', 10, 12);
    expect(err).toBeInstanceOf(SyncCodecError);
    expect(err.message).toBe(
      `Dropbox sync file "${SEGMENT}" is too large to read (12 > 10 bytes, the segment limit).`,
    );
  });
});

describe.each([
  ['Google Drive', googleDrive],
  ['Dropbox', dropbox],
  ['OneDrive', oneDrive],
])('%s read() is capped per sync file kind', (label, make) => {
  describe.each(Object.entries(PATHS) as Array<[SyncFileKind, string]>)('%s', (kind, path) => {
    const cap = SYNC_READ_CAPS[kind];

    it('refuses a Content-Length over the cap before reading the body', async () => {
      const { transport, setDownload } = make();
      await transport.write(path, new Uint8Array([1, 2, 3]));
      setDownload(() => declaredBody(cap + 1));
      const err = await errorOf(transport.read(path));
      expect(err).toBeInstanceOf(SyncReadTooLargeError);
      expect((err as Error).message).toBe(
        `${label} sync file "${path}" is too large to read (${cap + 1} > ${cap} bytes, the ${kind} limit).`,
      );
    });

    it('cancels a streamed body with no Content-Length once it passes the cap', async () => {
      const { transport, setDownload } = make();
      await transport.write(path, new Uint8Array([1, 2, 3]));
      const body = streamedBody(cap + 8 * CHUNK, CHUNK);
      setDownload(() => body.response);
      const err = await errorOf(transport.read(path));
      expect(err).toBeInstanceOf(SyncReadTooLargeError);
      expect((err as Error).message).toContain(`(more than ${cap} bytes, the ${kind} limit)`);
      expect(body.cancelled).toBe(true);
      expect(body.pulled).toBeLessThanOrEqual(cap + 2 * CHUNK);
    });
  });

  it('still reads the largest snapshot the codec reads, in full', async () => {
    const { transport, setDownload } = make();
    await transport.write(SNAPSHOT, new Uint8Array([1]));
    const size = SYNC_CODEC_LIMITS.maxCompressedBytes;
    setDownload(() => streamedBody(size, CHUNK).response);
    expect((await transport.read(SNAPSHOT)).byteLength).toBe(size);
  });

  it('still reads the head.json of a device with 100k pushed segments', async () => {
    const { transport, setDownload } = make();
    await transport.write(HEAD, new TextEncoder().encode('{}'));
    const head = longLivedHead(100_000);
    expect(head.byteLength).toBeGreaterThan(5 * MiB); // about 60 bytes a range
    setDownload(() => new Response(head.slice()));
    expect(await transport.read(HEAD)).toEqual(head);
  });
});

function memoryMediaStore(): SyncMediaStore & { blobs: Map<string, unknown> } {
  const blobs = new Map<string, { hash: string; mime: string; bytes: Uint8Array }>();
  return {
    blobs,
    getLocalMedia: async (hash) => blobs.get(hash),
    putLocalMedia: async (media) => {
      blobs.set(media.hash, media);
    },
  };
}

/** Device A pushes one preference event and one media blob through a fake Dropbox. */
async function seededDropbox() {
  const harness = dropbox();
  const t0 = Date.UTC(2026, 10, 27, 9, 0, 0);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const hash = sha256Hex(bytes);
  const storeA = memoryMediaStore();
  await storeA.putLocalMedia({ hash, mime: 'image/png', bytes });
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
  const events: FlashEvent[] = [
    factory.create('PreferencesChanged', { preferences: { day_start_hour: 5 } }, t0),
    factory.create(
      'MediaAdded',
      { media: { hash, ext: 'png', mime: 'image/png', size: bytes.byteLength } },
      t0 + 1,
    ),
  ];
  const pushed = await runSync({
    transport: harness.transport,
    deviceId: 'dev-a',
    cursor: createInitialSyncCursor(),
    localOwnSeq: events.length,
    nowMs: () => t0 + 100,
    getLocalEventsAfterSeq: async (after) => events.filter((e) => e.seq > after),
    mediaStore: storeA,
  });
  expect(pushed.status).toBe('ok');
  const pullAsB = () =>
    runSync({
      transport: harness.transport,
      deviceId: 'dev-b',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      nowMs: () => t0 + 200,
      getLocalEventsAfterSeq: async () => [],
      mediaStore: memoryMediaStore(),
      canBootstrapFromSnapshot: true,
    });
  return { harness, events, mediaPath: mediaObjectPath(hash, 'png'), pullAsB };
}

describe('runSync keeps its old outcome for each kind of over-cap file', () => {
  it('skips an over-cap snapshot candidate and syncs from the segments', async () => {
    const { harness, events, pullAsB } = await seededDropbox();
    await harness.transport.write(SNAPSHOT, new Uint8Array([1]));
    overrideReads(harness, { [SNAPSHOT]: () => declaredBody(SYNC_READ_CAPS.snapshot + 1) });
    const pulled = await pullAsB();
    expect(pulled.status).toBe('ok');
    expect(pulled.hydratedSnapshot).toBeUndefined();
    expect(pulled.pulledEvents.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it('skips an over-cap media blob with a warning and finishes the sync', async () => {
    const { harness, events, mediaPath, pullAsB } = await seededDropbox();
    const body = streamedBody(SYNC_READ_CAPS.media + 8 * CHUNK, CHUNK);
    overrideReads(harness, { [mediaPath]: () => body.response });
    const pulled = await pullAsB();
    expect(pulled.status).toBe('ok');
    expect(pulled.pulledEvents).toHaveLength(events.length);
    expect(pulled.pulledMediaCount).toBe(0);
    expect(pulled.mediaWarnings?.some((w) => w.includes(`"${mediaPath}" is too large`))).toBe(true);
    expect(body.cancelled).toBe(true);
  });

  it('stops that device at an over-cap segment with a pull warning, as a codec-refused one does', async () => {
    const { harness, pullAsB } = await seededDropbox();
    overrideReads(harness, { [SEGMENT]: () => declaredBody(SYNC_READ_CAPS.segment + 1) });
    const pulled = await pullAsB();
    expect(pulled.status).toBe('ok');
    expect(pulled.pulledEvents).toHaveLength(0);
    expect(pulled.pullWarnings?.some((w) => w.startsWith('Segment 1 from device dev-a'))).toBe(
      true,
    );
  });

  it('fails the sync on an over-cap head.json, as a corrupt head does', async () => {
    const { harness, pullAsB } = await seededDropbox();
    overrideReads(harness, { [HEAD]: () => declaredBody(SYNC_READ_CAPS.head + 1) });
    const err = await errorOf(pullAsB());
    expect(err).toBeInstanceOf(SyncReadTooLargeError);
    expect((err as Error).message).toContain(`"${HEAD}" is too large`);
  });
});
