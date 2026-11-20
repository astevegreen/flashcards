import { isSyncTransportError } from '@flash/core';
import type { Auth, AuthSession } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import { GoogleDriveAppDataTransport } from '../src/sync/google-drive-transport.ts';

function createMockAuth(tokens: string[] = ['token-1', 'token-2']): Auth {
  let idx = 0;
  return {
    isConfigured: () => true,
    isConnected: async () => true,
    getSession: async (): Promise<AuthSession | null> => ({
      provider: 'google',
      accessToken: tokens[idx] ?? 'token-1',
      expiresAt: Date.now() + 3_600_000,
    }),
    getValidAccessToken: vi.fn(async (opts?: { forceRefresh?: boolean }) => {
      if (opts?.forceRefresh && idx + 1 < tokens.length) {
        idx += 1;
      }
      return tokens[idx] ?? 'token-1';
    }),
    signIn: async () => null,
    handleRedirectCallback: async () => null,
    signOut: async () => {},
  };
}

function extractMultipartParts(
  body: ArrayBuffer | Uint8Array,
  contentType: string,
): { metadata: Record<string, unknown>; payload: Uint8Array } {
  const match = /boundary=([^\s;]+)/.exec(contentType);
  if (!match || !match[1]) throw new Error('Missing multipart boundary');
  const boundary = match[1];
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);

  const enc = new TextEncoder();
  const findSeq = (haystack: Uint8Array, needle: Uint8Array, from = 0): number => {
    outer: for (let i = from; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  };

  const sep = enc.encode(`--${boundary}`);
  const crlfcrlf = enc.encode('\r\n\r\n');
  const p1 = findSeq(bytes, sep, 0);
  const p1BodyStart = findSeq(bytes, crlfcrlf, p1) + 4;
  const p2 = findSeq(bytes, sep, p1BodyStart);
  const metaJson = new TextDecoder().decode(bytes.subarray(p1BodyStart, p2 - 2));

  const p2BodyStart = findSeq(bytes, crlfcrlf, p2) + 4;
  const endMarker = enc.encode(`\r\n--${boundary}--`);
  const p2End = findSeq(bytes, endMarker, p2BodyStart);
  const payload = new Uint8Array(bytes.subarray(p2BodyStart, p2End));

  return { metadata: JSON.parse(metaJson) as Record<string, unknown>, payload };
}

describe('GoogleDriveAppDataTransport unit tests (mocked fetch)', () => {
  it('supports binary-safe multipart create, ifAbsent conflict, PATCH update, paginated list, and read', async () => {
    const driveFiles = new Map<
      string,
      { id: string; name: string; bytes: Uint8Array; modifiedTime: string }
    >();
    let nextId = 1;

    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        const method = init?.method ?? 'GET';

        // GET list
        if (method === 'GET' && url.pathname === '/drive/v3/files') {
          expect(url.searchParams.get('spaces')).toBe('appDataFolder');
          const q = url.searchParams.get('q') ?? '';
          expect(q).not.toContain('name contains');
          const exactMatch = /name = '([^']+)'/.exec(q);
          const all = [...driveFiles.values()];
          const filtered = exactMatch ? all.filter((f) => f.name === exactMatch[1]) : all;

          // Exercise pagination with pageSize simulation when listing all
          const first = filtered[0];
          if (!exactMatch && filtered.length > 1 && first) {
            const pageToken = url.searchParams.get('pageToken');
            if (!pageToken) {
              return new Response(
                JSON.stringify({
                  files: [
                    {
                      id: first.id,
                      name: first.name,
                      size: String(first.bytes.byteLength),
                      modifiedTime: first.modifiedTime,
                    },
                  ],
                  nextPageToken: 'page-2',
                }),
                { status: 200 },
              );
            }
            return new Response(
              JSON.stringify({
                files: filtered.slice(1).map((f) => ({
                  id: f.id,
                  name: f.name,
                  size: String(f.bytes.byteLength),
                  modifiedTime: f.modifiedTime,
                })),
              }),
              { status: 200 },
            );
          }

          return new Response(
            JSON.stringify({
              files: filtered.map((f) => ({
                id: f.id,
                name: f.name,
                size: String(f.bytes.byteLength),
                modifiedTime: f.modifiedTime,
              })),
            }),
            { status: 200 },
          );
        }

        // GET alt=media
        if (method === 'GET' && url.pathname.startsWith('/drive/v3/files/')) {
          const fileId = decodeURIComponent(url.pathname.slice('/drive/v3/files/'.length));
          const found = [...driveFiles.values()].find((f) => f.id === fileId);
          if (!found) return new Response('Not found', { status: 404 });
          return new Response(found.bytes.slice(), { status: 200 });
        }

        // POST multipart create
        if (method === 'POST' && url.pathname === '/upload/drive/v3/files') {
          const ct = new Headers(init?.headers).get('Content-Type') ?? '';
          const { metadata, payload } = extractMultipartParts(init?.body as ArrayBuffer, ct);
          expect(metadata['parents']).toEqual(['appDataFolder']);
          const name = String(metadata['name']);
          const id = `drive-id-${nextId++}`;
          driveFiles.set(name, {
            id,
            name,
            bytes: payload,
            modifiedTime: new Date().toISOString(),
          });
          return new Response(JSON.stringify({ id, name }), { status: 200 });
        }

        // PATCH media update
        if (method === 'PATCH' && url.pathname.startsWith('/upload/drive/v3/files/')) {
          const fileId = decodeURIComponent(url.pathname.slice('/upload/drive/v3/files/'.length));
          const found = [...driveFiles.values()].find((f) => f.id === fileId);
          if (!found) return new Response('Not found', { status: 404 });
          found.bytes = new Uint8Array(init?.body as ArrayBuffer);
          found.modifiedTime = new Date().toISOString();
          return new Response(JSON.stringify({ id: found.id }), { status: 200 });
        }

        return new Response('Unhandled', { status: 500 });
      },
    );

    const transport = new GoogleDriveAppDataTransport({
      auth: createMockAuth(),
      fetchImpl: mockFetch,
      sleep: async () => {},
    });

    // Binary-safe round-trip with every byte 0x00..0xff (verifying .jsonl.gz binary integrity!)
    const binarySegment = new Uint8Array(256);
    for (let i = 0; i < 256; i++) binarySegment[i] = i;

    await transport.write('sync/v1/devices/dev-a/seg-000001.jsonl.gz', binarySegment, {
      ifAbsent: true,
    });
    const readBack = await transport.read('sync/v1/devices/dev-a/seg-000001.jsonl.gz');
    expect(Array.from(readBack)).toEqual(Array.from(binarySegment));

    // ifAbsent on existing write-once file throws ALREADY_EXISTS
    await expect(
      transport.write('sync/v1/devices/dev-a/seg-000001.jsonl.gz', binarySegment, {
        ifAbsent: true,
      }),
    ).rejects.toSatisfy((err) => isSyncTransportError(err) && err.code === 'ALREADY_EXISTS');

    // Mutable head.json create + PATCH overwrite
    const head1 = new TextEncoder().encode('{"last_seq":1}');
    const head2 = new TextEncoder().encode('{"last_seq":2}');
    await transport.write('sync/v1/devices/dev-a/head.json', head1);
    await transport.write('sync/v1/devices/dev-a/head.json', head2);
    expect(new TextDecoder().decode(await transport.read('sync/v1/devices/dev-a/head.json'))).toBe(
      '{"last_seq":2}',
    );

    // Paginated list across 2 pages + exact prefix filter
    const listed = await transport.list('sync/v1/devices/');
    expect(listed.map((f) => f.path)).toEqual([
      'sync/v1/devices/dev-a/head.json',
      'sync/v1/devices/dev-a/seg-000001.jsonl.gz',
    ]);

    // Missing file returns NOT_FOUND
    await expect(transport.read('sync/v1/missing.json')).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'NOT_FOUND',
    );
  });

  it('retries once on HTTP 401 with forceRefresh, backs off on 429/503, and maps offline network errors', async () => {
    const auth = createMockAuth(['stale-token', 'fresh-token']);
    const sleepCalls: number[] = [];
    let callCount = 0;

    const mockFetch = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        callCount += 1;
        const authHeader = new Headers(init?.headers).get('Authorization');
        if (callCount === 1) {
          expect(authHeader).toBe('Bearer stale-token');
          return new Response('Unauthorized', { status: 401 });
        }
        if (callCount === 2) {
          expect(authHeader).toBe('Bearer fresh-token');
          return new Response('Rate limited', { status: 429 });
        }
        if (callCount === 3) {
          return new Response('Unavailable', { status: 503 });
        }
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      },
    );

    const transport = new GoogleDriveAppDataTransport({
      auth,
      fetchImpl: mockFetch,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    const files = await transport.list('sync/v1/');
    expect(files).toEqual([]);
    expect(auth.getValidAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);

    // Offline network rejection maps cleanly to SyncTransportError('NETWORK')
    const offlineTransport = new GoogleDriveAppDataTransport({
      auth,
      fetchImpl: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
      sleep: async () => {},
    });
    await expect(offlineTransport.list('sync/v1/')).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'NETWORK',
    );
  });

  it('re-resolves stale cached fileId on HTTP 404 during read()', async () => {
    const auth = createMockAuth();
    let currentId = 'old-file-id';
    const payload = new TextEncoder().encode('{"recovered":true}');

    const mockFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname === '/drive/v3/files') {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: currentId,
                name: 'sync/v1/manifest.json',
                size: String(payload.byteLength),
                modifiedTime: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.pathname === '/drive/v3/files/old-file-id') {
        return new Response('Not found', { status: 404 });
      }
      if (url.pathname === '/drive/v3/files/new-file-id') {
        return new Response(payload.slice(), { status: 200 });
      }
      return new Response('Unexpected', { status: 500 });
    });

    const transport = new GoogleDriveAppDataTransport({
      auth,
      fetchImpl: mockFetch,
      sleep: async () => {},
    });

    // Warm pathToId cache with old-file-id via list()
    await transport.list('sync/v1/');
    // Simulate file recreated on Drive under new-file-id while cache still holds old-file-id
    currentId = 'new-file-id';

    const bytes = await transport.read('sync/v1/manifest.json');
    expect(new TextDecoder().decode(bytes)).toBe('{"recovered":true}');
  });
});
