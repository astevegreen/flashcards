import {
  createEventFactory,
  createHlcState,
  createInitialSyncCursor,
  deviceHeadPath,
  deviceSegmentPath,
  isSyncTransportError,
  manifestPath,
  mediaObjectPath,
  snapshotPath,
  SYNC_CODEC_LIMITS,
  SYNC_MEDIA_LIMITS,
} from '@flash/core';
import type { SyncTransport } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import { DropboxAppFolderTransport } from '../src/sync/dropbox-transport.ts';
import { GoogleDriveAppDataTransport } from '../src/sync/google-drive-transport.ts';
import { OneDriveAppFolderTransport } from '../src/sync/onedrive-transport.ts';
import { SYNC_READ_CAPS, syncFileKind } from '../src/sync/sync-read-caps.ts';
import { FakeDriveServer } from './fakes/fake-drive.ts';
import { FakeDropboxServer } from './fakes/fake-dropbox.ts';
import { FAKE_DOWNLOAD_ORIGIN, FakeGraphServer } from './fakes/fake-graph.ts';
import { declaredBody, streamedBody } from './helpers/oversized-body.ts';

const MiB = 1024 * 1024;
const SNAPSHOT = snapshotPath('dev-a', 42);
const HEAD = deviceHeadPath('dev-a');

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

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

describe('sync file kinds and caps', () => {
  it('classifies every sync path the engine reads', () => {
    expect(syncFileKind(manifestPath())).toBe('head');
    expect(syncFileKind(HEAD)).toBe('head');
    expect(syncFileKind(deviceSegmentPath('dev-a', 7))).toBe('segment');
    expect(syncFileKind(SNAPSHOT)).toBe('snapshot');
    expect(syncFileKind(mediaObjectPath('ab'.repeat(32), 'png'))).toBe('media');
    // An unknown path gets the largest cap rather than the smallest.
    expect(syncFileKind('sync/v1/other.bin')).toBe('snapshot');
  });

  it('sits above what the codec and the media check read, so no readable file is refused', () => {
    expect(SYNC_READ_CAPS.segment).toBeGreaterThan(SYNC_CODEC_LIMITS.maxCompressedBytes);
    expect(SYNC_READ_CAPS.snapshot).toBeGreaterThan(SYNC_CODEC_LIMITS.maxCompressedBytes);
    expect(SYNC_READ_CAPS.media).toBeGreaterThan(SYNC_MEDIA_LIMITS.maxMediaBlobBytes);
  });
});

describe.each([
  ['Google Drive', googleDrive],
  ['Dropbox', dropbox],
  ['OneDrive', oneDrive],
])('%s read() is capped per sync file kind', (label, make) => {
  it('refuses a snapshot whose Content-Length is over the snapshot cap, before reading it', async () => {
    const { transport, setDownload } = make();
    await transport.write(SNAPSHOT, new Uint8Array([1, 2, 3]));
    setDownload(() => declaredBody(SYNC_READ_CAPS.snapshot + 1));
    const err = await errorOf(transport.read(SNAPSHOT));
    expect(isSyncTransportError(err) && err.code).toBe('UNKNOWN');
    expect((err as Error).message).toContain(`${label} sync file "${SNAPSHOT}" is too large`);
    expect((err as Error).message).toContain(`${SYNC_READ_CAPS.snapshot + 1} >`);
  });

  it('stops a streamed head.json with no Content-Length once it passes the head cap', async () => {
    const { transport, setDownload } = make();
    await transport.write(HEAD, new TextEncoder().encode('{}'));
    const body = streamedBody(64 * MiB, 64 * 1024);
    setDownload(() => body.response);
    const err = await errorOf(transport.read(HEAD));
    expect(isSyncTransportError(err) && err.code).toBe('UNKNOWN');
    expect((err as Error).message).toMatch(
      /too large to read \(more than \d+ bytes, the head limit\)/,
    );
    expect(body.cancelled).toBe(true);
    expect(body.pulled).toBeLessThanOrEqual(SYNC_READ_CAPS.head + 2 * 64 * 1024);
  });

  it('still reads a large snapshot under the cap in full', async () => {
    const { transport, setDownload } = make();
    await transport.write(SNAPSHOT, new Uint8Array([1]));
    const size = SYNC_CODEC_LIMITS.maxCompressedBytes; // the largest snapshot the codec reads
    setDownload(() => streamedBody(size, MiB).response);
    expect((await transport.read(SNAPSHOT)).byteLength).toBe(size);
  });
});

describe('a capped read reaches the sync engine as a typed error', () => {
  it('runSync rejects with the transport error, not a truncated head', async () => {
    const { runSync } = await import('@flash/core/sync');
    const { transport, setDownload } = dropbox();
    const t0 = Date.UTC(2026, 10, 27, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const events = [
      factory.create('PreferencesChanged', { preferences: { day_start_hour: 5 } }, t0),
    ];
    await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 1,
      nowMs: () => t0 + 100,
      getLocalEventsAfterSeq: async (after) => events.filter((e) => e.seq > after),
    });

    let oversized: ReturnType<typeof streamedBody> | undefined;
    const real = transport.read.bind(transport);
    vi.spyOn(transport, 'read').mockImplementation(async (path) => {
      setDownload(
        path === HEAD
          ? () => {
              oversized = streamedBody(8 * MiB, 64 * 1024);
              return oversized.response;
            }
          : undefined,
      );
      return real(path);
    });
    const err = await errorOf(
      runSync({
        transport,
        deviceId: 'dev-b',
        cursor: createInitialSyncCursor(),
        localOwnSeq: 0,
        nowMs: () => t0 + 200,
        getLocalEventsAfterSeq: async () => [],
      }),
    );
    expect(isSyncTransportError(err) && err.code).toBe('UNKNOWN');
    expect((err as Error).message).toContain(`"${HEAD}" is too large`);
    expect(oversized?.cancelled).toBe(true);
  });
});
