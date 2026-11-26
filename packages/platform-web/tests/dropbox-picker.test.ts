import { isSyncTransportError } from '@flash/core';
import type { Storage } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import { DropboxRefreshRejectedError, NativeDropboxAuth } from '../src/auth/dropbox-native-auth.ts';
import {
  DropboxAppFolderFilePicker,
  encodeDropboxApiArg,
  isPickableDropboxFile,
} from '../src/sources/dropbox-picker.ts';
import { FakeDropboxServer } from './fakes/fake-dropbox.ts';

const enc = new TextEncoder();

function setup(
  options: {
    connected?: boolean;
    maxBytes?: number;
    pageSize?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const server = new FakeDropboxServer({ pageSize: options.pageSize ?? 2 });
  // Internal sync folders at root — must be hidden from the user's file browser.
  server.put('sync/v1/manifest.json', enc.encode('{}'), 1_700_000_000_000);
  server.put('media/ab/abcdef.png', new Uint8Array([1, 2, 3]), 1_700_000_000_000);
  // User files & folders inside Dropbox/Apps/<app name>/
  server.put('Decks/korean.csv', enc.encode('Front,Back\n개,dog\n'), 1_700_000_000_000);
  server.put('Decks/notes.docx', enc.encode('ignored'), 1_700_000_000_000);
  server.put('Decks/sync/nested.csv', enc.encode('Front,Back\n물,water\n'), 1_700_000_000_000);
  server.put('vocab.xlsx', new Uint8Array([80, 75, 5, 6]), 1_700_000_000_000);
  server.put('deck.flashpkg', new Uint8Array([80, 75, 3, 4]), 1_700_000_000_000);
  server.put('photo.jpg', new Uint8Array([9]), 1_700_000_000_000);

  const auth = {
    isConfigured: () => true,
    isConnected: vi.fn(async () => options.connected !== false),
    getValidAccessToken: vi.fn(async () => 'dbx-token-1'),
    signIn: vi.fn(async () => null),
  };
  const picker = new DropboxAppFolderFilePicker({
    auth,
    fetchImpl: server.fetch,
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    ...(options.sleep ? { sleep: options.sleep, random: () => 0 } : {}),
  });
  return { server, auth, picker };
}

describe('DropboxAppFolderFilePicker', () => {
  it('retries a 429 on listing, metadata and download through the shared client (R1)', async () => {
    const sleeps: number[] = [];
    const { server, picker } = setup({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    for (const endpoint of ['/files/list_folder', '/files/get_metadata', '/files/download']) {
      let throttled = 0;
      server.inject({
        match: (req) => new URL(req.url).pathname.endsWith(endpoint) && throttled++ === 0,
        status: 429,
        body: { error_summary: 'too_many_requests/' },
      });
    }
    const decks = await picker.listFolder('/Decks');
    const csv = decks.find((i) => i.name === 'korean.csv');
    if (!csv) throw new Error('korean.csv is missing from the listing');
    const file = await picker.downloadFile(csv);
    expect(new TextDecoder().decode(file.bytes)).toContain('개,dog');
    expect(sleeps).toHaveLength(3);
  });

  it('lists folders first then pickable files, hides root sync/ and media/, and follows pagination', async () => {
    const { picker } = setup();
    const root = await picker.listFolder();
    expect(root.map((i) => `${i.kind}:${i.name}`)).toEqual([
      'folder:Decks',
      'file:deck.flashpkg',
      'file:vocab.xlsx',
    ]);

    const decks = await picker.listFolder('/Decks');
    // Nested folder named "sync" inside /Decks is NOT hidden (only App Folder root sync/ and media/).
    expect(decks.map((i) => `${i.kind}:${i.name}`)).toEqual(['folder:sync', 'file:korean.csv']);
  });

  it('downloads picked files and checks contentTag changes via getFileInfo', async () => {
    const { server, picker } = setup();
    const decks = await picker.listFolder('/Decks');
    const csv = decks.find((i) => i.name === 'korean.csv');
    if (!csv) throw new Error('missing korean.csv');

    const before = await picker.getFileInfo(csv.id);
    expect(before.name).toBe('korean.csv');
    expect(before.contentTag).toBeTruthy();

    const picked = await picker.downloadFile(csv);
    expect(picked.name).toBe('korean.csv');
    expect(picked.mime).toBe('text/csv');
    expect(new TextDecoder().decode(picked.bytes)).toContain('개,dog');

    server.put('Decks/korean.csv', enc.encode('Front,Back\n개,dog\n고양이,cat\n'));
    const after = await picker.getFileInfo(csv.id);
    expect(after.contentTag).not.toBe(before.contentTag);
  });

  it('refuses unsupported extensions, oversized files, and traversal paths (§13)', async () => {
    const { server, picker } = setup({ maxBytes: 4 });
    const xlsx = (await picker.listFolder()).find((i) => i.name === 'vocab.xlsx');
    if (!xlsx) throw new Error('missing vocab.xlsx');
    await expect(picker.downloadFile({ ...xlsx, size: 10 })).rejects.toThrow(/50 MB/);
    await expect(
      picker.downloadFile({
        id: 'id:x',
        name: 'photo.jpg',
        pathDisplay: '/photo.jpg',
        pathLower: '/photo.jpg',
        kind: 'file',
        size: 1,
      }),
    ).rejects.toThrow(/not a \.csv/);
    await expect(picker.listFolder('../escape')).rejects.toThrow(/Unsafe/);
    for (const path of ['Decks/../..', 'Decks\\..', '/..', 'Decks\0', 'Decks/.', './Decks', '/.']) {
      await expect(picker.listFolder(path)).rejects.toThrow(/Unsafe/);
      await expect(picker.getFileInfo(`${path}/korean.csv`)).rejects.toThrow(/Unsafe|Invalid/);
    }
    const docx = server.findByIdOrPath('/Decks/notes.docx');
    await expect(picker.downloadById(docx?.id ?? '')).rejects.toThrow(/not a \.csv/);
    expect(isPickableDropboxFile('Deck.FLASHPKG')).toBe(true);
    expect(isPickableDropboxFile('archive.zip')).toBe(false);
  });

  it('accepts folder and file names that only contain `..` inside a segment (review §11)', async () => {
    const { server, picker } = setup();
    server.put('Decks..old/a..b.csv', enc.encode('Front,Back\n개,dog\n'), 1_700_000_000_000);
    const items = await picker.listFolder('Decks..old/');
    expect(items.map((i) => i.name)).toEqual(['a..b.csv']);
    expect((await picker.getFileInfo('Decks..old/a..b.csv')).name).toBe('a..b.csv');
  });

  it('escapes non-ASCII characters in Dropbox-API-Arg header', () => {
    const encoded = encodeDropboxApiArg({ path: '/한국어/단어.csv' });
    expect(/^[\x20-\x7e]+$/.test(encoded)).toBe(true);
    expect(JSON.parse(encoded)).toEqual({ path: '/한국어/단어.csv' });
  });

  it('retries once on 401 with forceRefresh and maps 409 not_found to NOT_FOUND', async () => {
    const { server, auth, picker } = setup();
    let failedOnce = false;
    server.inject({
      match: (req) => {
        if (!failedOnce && req.url.endsWith('/files/list_folder')) {
          failedOnce = true;
          return true;
        }
        return false;
      },
      status: 401,
      body: { error_summary: 'expired_access_token' },
    });
    const root = await picker.listFolder();
    expect(root.length).toBeGreaterThan(0);
    expect(auth.getValidAccessToken).toHaveBeenCalledWith({ forceRefresh: true });

    await expect(picker.getFileInfo('id:missing')).rejects.toSatisfy(
      (err: unknown) => isSyncTransportError(err) && err.code === 'NOT_FOUND',
    );
  });

  it('connects with intent "sources" and shares connection state', async () => {
    const { auth, picker } = setup({ connected: false });
    expect(await picker.isConnected()).toBe(false);
    expect(await picker.connect()).toBe(false);
    expect(auth.signIn).toHaveBeenCalledWith({ intent: 'sources' });
  });
});

describe('NativeDropboxAuth', () => {
  function memStorage(): Storage {
    const map = new Map<string, unknown>();
    return {
      getKv: async <T = unknown>(k: string) => map.get(k) as T | undefined,
      setKv: async (k: string, v: unknown) => {
        map.set(k, structuredClone(v));
      },
      deleteKv: async (k: string) => {
        map.delete(k);
      },
    } as unknown as Storage;
  }

  it('signs in, caches access token, refreshes on expiry, and handles rejection', async () => {
    let clock = 1_750_000_000_000;
    const bridge = {
      authorize: vi.fn(async () => ({ accessToken: 'tok-1', expiresInSeconds: 3600 })),
      refresh: vi
        .fn()
        .mockResolvedValueOnce({ accessToken: 'tok-2', expiresInSeconds: 3600 })
        .mockRejectedValueOnce(new DropboxRefreshRejectedError('revoked')),
      signOut: vi.fn(async () => {}),
    };
    const auth = new NativeDropboxAuth({
      bridge,
      storage: memStorage(),
      nowMs: () => clock,
    });

    expect(await auth.isConnected()).toBe(false);
    const session = await auth.signIn({ intent: 'sources' });
    expect(session?.provider).toBe('dropbox');
    expect(session?.intent).toBe('sources');
    expect(await auth.getValidAccessToken()).toBe('tok-1');

    clock += 3600 * 1000;
    expect(await auth.getValidAccessToken()).toBe('tok-2');

    clock += 3600 * 1000;
    await expect(auth.getValidAccessToken()).rejects.toSatisfy(
      (err: unknown) => isSyncTransportError(err) && err.code === 'AUTH_REQUIRED',
    );
    expect(await auth.isConnected()).toBe(false);

    await auth.signOut();
    expect(bridge.signOut).toHaveBeenCalledTimes(1);
  });

  it('runs one bridge refresh for concurrent callers, and needs a bridge to refresh', async () => {
    let clock = 0;
    const storage = memStorage();
    let n = 0;
    const bridge = {
      authorize: vi.fn(async () => ({ accessToken: 'tok-0', expiresInSeconds: 3600 })),
      refresh: vi.fn(async () => ({ accessToken: `tok-${++n}`, expiresInSeconds: 3600 })),
      signOut: vi.fn(async () => {}),
    };
    const auth = new NativeDropboxAuth({ bridge, storage, nowMs: () => clock });
    await auth.signIn();
    clock += 3600 * 1000;
    const tokens = await Promise.all([auth.getValidAccessToken(), auth.getValidAccessToken()]);
    expect(tokens).toEqual(['tok-1', 'tok-1']);
    expect(bridge.refresh).toHaveBeenCalledTimes(1);

    const noBridge = new NativeDropboxAuth({ storage, nowMs: () => clock });
    expect(await noBridge.getValidAccessToken()).toBe('tok-1');
    clock += 3600 * 1000;
    await expect(noBridge.getValidAccessToken()).rejects.toThrow(
      'Dropbox sign-in is not configured in this build.',
    );
  });
});
