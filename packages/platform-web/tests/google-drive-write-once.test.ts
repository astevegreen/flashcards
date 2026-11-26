import { isSyncTransportError } from '@flash/core';
import type { Auth } from '@flash/platform';
import { describe, expect, it } from 'vitest';
import { GoogleDriveAppDataTransport } from '../src/sync/google-drive-transport.ts';

interface FakeFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  createdTime: string;
  modifiedTime: string;
  appProperties?: Record<string, string>;
}

const auth = { getValidAccessToken: async () => 'token' } as unknown as Auth;

/** Splits a multipart/related upload into its JSON metadata and its payload (latin1-safe). */
function parseUpload(body: ArrayBuffer): { meta: Record<string, unknown>; bytes: Uint8Array } {
  const text = new TextDecoder('latin1').decode(body);
  const boundary = text.slice(2, text.indexOf('\r\n'));
  const [, part1 = '', part2 = ''] = text.split(`--${boundary}`);
  const json = part1.slice(part1.indexOf('\r\n\r\n') + 4, -2);
  const payload = part2.slice(part2.indexOf('\r\n\r\n') + 4, -2);
  return {
    meta: JSON.parse(json) as Record<string, unknown>,
    bytes: Uint8Array.from(payload, (c) => c.charCodeAt(0)),
  };
}

/**
 * An appDataFolder that, like Drive, lets several files share one name. `holdLookups` makes the
 * first `n` by-name lookups wait for each other, so two devices both see "absent" before either
 * creates: the race C23 is about.
 */
function fakeDrive(holdLookups = 0) {
  const files: FakeFile[] = [];
  const deleted: string[] = [];
  let clock = Date.UTC(2026, 10, 25, 9, 0, 0);
  let nextId = 1;
  let waiting: (() => void)[] = [];
  /** Fault injection: by-name lookups to fail once a file exists, and the DELETE status. */
  const faults = { failLookupsAfterCreate: 0, deleteStatus: 204 };
  let creates = 0;
  const row = (f: FakeFile) => ({
    id: f.id,
    name: f.name,
    size: String(f.bytes.byteLength),
    createdTime: f.createdTime,
    modifiedTime: f.modifiedTime,
    ...(f.appProperties ? { appProperties: f.appProperties } : {}),
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const exact = /name = '([^']+)'/.exec(url.searchParams.get('q') ?? '')?.[1];
      if (exact !== undefined && creates > 0 && faults.failLookupsAfterCreate > 0) {
        faults.failLookupsAfterCreate -= 1;
        return new Response('Bad request', { status: 400 });
      }
      if (exact !== undefined && holdLookups > 0) {
        holdLookups -= 1;
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (holdLookups === 0) {
            for (const go of waiting) go();
            waiting = [];
          }
        });
      }
      const matches = files.filter((f) => exact === undefined || f.name === exact);
      return new Response(JSON.stringify({ files: matches.map(row) }), { status: 200 });
    }
    if (method === 'GET' && url.pathname.startsWith('/drive/v3/files/')) {
      const id = decodeURIComponent(url.pathname.slice('/drive/v3/files/'.length));
      const f = files.find((x) => x.id === id);
      return f ? new Response(f.bytes.slice(), { status: 200 }) : new Response('', { status: 404 });
    }
    if (method === 'DELETE' && url.pathname.startsWith('/drive/v3/files/')) {
      const id = decodeURIComponent(url.pathname.slice('/drive/v3/files/'.length));
      const i = files.findIndex((x) => x.id === id);
      if (i < 0) return new Response('', { status: 404 });
      if (faults.deleteStatus !== 204) return new Response('', { status: faults.deleteStatus });
      files.splice(i, 1);
      deleted.push(id);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const { meta, bytes } = parseUpload(init?.body as ArrayBuffer);
      const at = new Date((clock += 1)).toISOString();
      const id = `id-${nextId++}`;
      creates += 1;
      files.push({
        id,
        name: String(meta['name']),
        bytes,
        createdTime: at,
        modifiedTime: at,
        ...(meta['appProperties']
          ? { appProperties: meta['appProperties'] as Record<string, string> }
          : {}),
      });
      return new Response(JSON.stringify({ id, name: meta['name'] }), { status: 200 });
    }
    return new Response('Unhandled', { status: 500 });
  }) as typeof fetch;
  return { files, deleted, faults, creates: () => creates, fetchImpl };
}

const MANIFEST = 'sync/v1/manifest.json';
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('Google Drive write-once files (C23)', () => {
  it('two devices racing to create the manifest: one wins, the other gets ALREADY_EXISTS', async () => {
    const drive = fakeDrive(2);
    const a = new GoogleDriveAppDataTransport({ auth, fetchImpl: drive.fetchImpl });
    const b = new GoogleDriveAppDataTransport({ auth, fetchImpl: drive.fetchImpl });

    const results = await Promise.allSettled([
      a.write(MANIFEST, enc('{"from":"a"}'), { ifAbsent: true }),
      b.write(MANIFEST, enc('{"from":"b"}'), { ifAbsent: true }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = results.find((r) => r.status === 'rejected');
    expect(
      lost?.status === 'rejected' &&
        isSyncTransportError(lost.reason) &&
        lost.reason.code === 'ALREADY_EXISTS',
    ).toBe(true);
    // The first file created is the one kept; the loser removed its own copy.
    expect(drive.files.map((f) => dec(f.bytes))).toEqual(['{"from":"a"}']);
    expect(drive.deleted).toEqual(['id-2']);
    expect(dec(await a.read(MANIFEST))).toBe('{"from":"a"}');
    expect(dec(await b.read(MANIFEST))).toBe('{"from":"a"}');
  });

  it('duplicates left behind resolve to the first-created copy on every device', async () => {
    const drive = fakeDrive();
    const stamp = (s: number) => new Date(Date.UTC(2026, 10, 25, 9, 0, s)).toISOString();
    const once = { flashWriteOnce: '1' };
    drive.files.push(
      {
        id: 'z',
        name: MANIFEST,
        bytes: enc('late'),
        createdTime: stamp(5),
        modifiedTime: stamp(5),
        appProperties: once,
      },
      {
        id: 'y',
        name: MANIFEST,
        bytes: enc('tie-y'),
        createdTime: stamp(1),
        modifiedTime: stamp(1),
        appProperties: once,
      },
      {
        id: 'x',
        name: MANIFEST,
        bytes: enc('tie-x'),
        createdTime: stamp(1),
        modifiedTime: stamp(1),
        appProperties: once,
      },
    );
    const viaRead = new GoogleDriveAppDataTransport({ auth, fetchImpl: drive.fetchImpl });
    expect(dec(await viaRead.read(MANIFEST))).toBe('tie-x');
    // `list` warms the same id cache `read` then uses: it must pick the same copy.
    const viaList = new GoogleDriveAppDataTransport({ auth, fetchImpl: drive.fetchImpl });
    drive.files.reverse();
    await viaList.list('sync/v1/');
    expect(dec(await viaList.read(MANIFEST))).toBe('tie-x');
  });

  it('files from older builds (not marked write-once) keep the newest-modified rule', async () => {
    const drive = fakeDrive();
    const stamp = (s: number) => new Date(Date.UTC(2026, 10, 25, 9, 0, s)).toISOString();
    const head = 'sync/v1/devices/dev-a/head.json';
    drive.files.push(
      { id: 'old', name: head, bytes: enc('stale'), createdTime: stamp(0), modifiedTime: stamp(1) },
      { id: 'new', name: head, bytes: enc('fresh'), createdTime: stamp(2), modifiedTime: stamp(9) },
    );
    const t = new GoogleDriveAppDataTransport({ auth, fetchImpl: drive.fetchImpl });
    expect(dec(await t.read(head))).toBe('fresh');
  });
  it('a failed delete of the losing copy still reports ALREADY_EXISTS', async () => {
    const drive = fakeDrive(2);
    drive.faults.deleteStatus = 503;
    const opts = { auth, fetchImpl: drive.fetchImpl, sleep: async () => {} };
    const a = new GoogleDriveAppDataTransport(opts);
    const b = new GoogleDriveAppDataTransport(opts);
    const results = await Promise.allSettled([
      a.write(MANIFEST, enc('{"from":"a"}'), { ifAbsent: true }),
      b.write(MANIFEST, enc('{"from":"b"}'), { ifAbsent: true }),
    ]);
    const lost = results.find((r) => r.status === 'rejected');
    expect(
      lost?.status === 'rejected' &&
        isSyncTransportError(lost.reason) &&
        lost.reason.code === 'ALREADY_EXISTS',
    ).toBe(true);
    // The loser's copy is still there, and every device reads the first one.
    expect(drive.files).toHaveLength(2);
    const fresh = new GoogleDriveAppDataTransport(opts);
    for (const t of [a, b, fresh]) expect(dec(await t.read(MANIFEST))).toBe('{"from":"a"}');
  });

  it('a lookup failing right after the create: the retry finds that copy and creates no other', async () => {
    const drive = fakeDrive();
    drive.faults.failLookupsAfterCreate = 1;
    const t = new GoogleDriveAppDataTransport({ auth, fetchImpl: drive.fetchImpl });
    await expect(t.write(MANIFEST, enc('{"v":1}'), { ifAbsent: true })).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'UNKNOWN',
    );
    await expect(t.write(MANIFEST, enc('{"v":1}'), { ifAbsent: true })).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'ALREADY_EXISTS',
    );
    expect(drive.creates()).toBe(1);
    expect(dec(await t.read(MANIFEST))).toBe('{"v":1}');
  });

  it('a mix of marked and unmarked copies falls back to the newest-modified rule', async () => {
    const drive = fakeDrive();
    const stamp = (s: number) => new Date(Date.UTC(2026, 10, 25, 9, 0, s)).toISOString();
    drive.files.push(
      {
        id: 'marked',
        name: MANIFEST,
        bytes: enc('marked-first'),
        createdTime: stamp(0),
        modifiedTime: stamp(0),
        appProperties: { flashWriteOnce: '1' },
      },
      // From an older build racing a newer one: no mark, created later.
      {
        id: 'plain',
        name: MANIFEST,
        bytes: enc('plain-later'),
        createdTime: stamp(4),
        modifiedTime: stamp(4),
      },
    );
    const viaRead = new GoogleDriveAppDataTransport({ auth, fetchImpl: drive.fetchImpl });
    expect(dec(await viaRead.read(MANIFEST))).toBe('plain-later');
    const viaList = new GoogleDriveAppDataTransport({ auth, fetchImpl: drive.fetchImpl });
    await viaList.list('sync/v1/');
    expect(dec(await viaList.read(MANIFEST))).toBe('plain-later');
  });
});
