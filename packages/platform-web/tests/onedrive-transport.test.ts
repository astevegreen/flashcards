import { createInitialSyncCursor, isSyncTransportError } from '@flash/core';
import { describe, expect, it, vi } from 'vitest';
import {
  ONEDRIVE_UPLOAD_CHUNK_UNIT,
  OneDriveAppFolderTransport,
  parseRetryAfterMs,
} from '../src/sync/onedrive-transport.ts';
import { InMemorySyncTransport } from '../src/sync/in-memory-transport.ts';
import { FakeGraphServer, requestMatches } from './fakes/fake-graph.ts';
import { describeSyncTransportContract } from './helpers/sync-transport-contract.ts';

function createAuth(tokens: string[] = ['graph-token-1']) {
  let idx = 0;
  return {
    getValidAccessToken: vi.fn(async (opts?: { forceRefresh?: boolean }) => {
      if (opts?.forceRefresh && idx + 1 < tokens.length) idx += 1;
      return tokens[idx] ?? 'graph-token-1';
    }),
  };
}

function setup(options: { tokens?: string[]; pageSize?: number; validTokens?: string[] } = {}) {
  const graph = new FakeGraphServer({
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    ...(options.validTokens ? { validTokens: options.validTokens } : {}),
  });
  const auth = createAuth(options.tokens);
  const sleep = vi.fn(async (_ms: number) => {});
  const transport = new OneDriveAppFolderTransport({
    auth,
    fetchImpl: graph.fetch,
    sleep,
    random: () => 0.5,
  });
  return { graph, auth, sleep, transport };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

function patterned(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) % 251;
  return out;
}

describeSyncTransportContract('InMemorySyncTransport', () => new InMemorySyncTransport());
describeSyncTransportContract('OneDriveAppFolderTransport (fake Graph)', () => setup().transport);
describeSyncTransportContract(
  'OneDriveAppFolderTransport (fake Graph, 2-item pages)',
  () => setup({ pageSize: 2 }).transport,
);

describe('OneDriveAppFolderTransport specifics (§4.3, §15 Phase 12)', () => {
  it('addresses the app folder by path and uses conflictBehavior=fail for ifAbsent', async () => {
    const { graph, transport } = setup();
    await transport.write('sync/v1/manifest.json', new Uint8Array([1]), { ifAbsent: true });
    await transport.write('sync/v1/devices/a/head.json', new Uint8Array([2]));
    const puts = graph.log.filter((r) => r.method === 'PUT').map((r) => new URL(r.url));
    expect(puts[0]?.pathname).toBe(
      '/v1.0/me/drive/special/approot:/sync/v1/manifest.json:/content',
    );
    expect(puts[0]?.searchParams.get('@microsoft.graph.conflictBehavior')).toBe('fail');
    expect(puts[1]?.searchParams.get('@microsoft.graph.conflictBehavior')).toBe('replace');
  });

  it('uploads files over 4 MB through an upload session in 320 KiB multiples', async () => {
    const { graph, transport } = setup();
    const big = patterned(4 * 1024 * 1024 + 123_457);
    await transport.write('media/ab/big.bin', big, { ifAbsent: true });

    const created = graph.log.filter((r) => r.url.includes('createUploadSession'));
    expect(created).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(created[0]?.body))).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'fail' },
    });
    expect(graph.uploadedFragments.length).toBeGreaterThan(1);
    for (const frag of graph.uploadedFragments.slice(0, -1)) {
      expect((frag.end - frag.start + 1) % ONEDRIVE_UPLOAD_CHUNK_UNIT).toBe(0);
    }
    expect(graph.uploadedFragments.at(-1)?.end).toBe(big.byteLength - 1);
    expect(graph.authLeaks).toEqual([]);
    expect(await transport.read('media/ab/big.bin')).toEqual(big);
  });

  it('maps a large ifAbsent conflict to ALREADY_EXISTS and keeps the original', async () => {
    const { transport } = setup();
    const big = patterned(4 * 1024 * 1024 + 1);
    await transport.write('media/ab/dup.bin', big, { ifAbsent: true });
    const err = await errorOf(
      transport.write('media/ab/dup.bin', patterned(5 * 1024 * 1024), { ifAbsent: true }),
    );
    expect(isSyncTransportError(err) && err.code).toBe('ALREADY_EXISTS');
    expect(await transport.read('media/ab/dup.bin')).toEqual(big);
  });

  it('retries a failed fragment, and resumes from nextExpectedRanges after a 416', async () => {
    const { graph, transport } = setup();
    const big = patterned(10 * 1024 * 1024 + 10); // 4 fragments of 3.125 MiB
    const isFragment = (url: string) => url.startsWith('https://fake-onedrive-upload.test');
    const fragmentPutNumber = () =>
      graph.log.filter((r) => r.method === 'PUT' && isFragment(r.url)).length;
    // PUT #2 (fragment 2) fails outright once: a plain retry.
    graph.inject({
      match: (req) => req.method === 'PUT' && isFragment(req.url) && fragmentPutNumber() === 2,
      status: 503,
    });
    // PUT #4 (fragment 3) lands but its response is lost (502): the re-sent PUT gets 416, so the
    // transport asks the session for nextExpectedRanges and continues after it.
    graph.inject({
      match: (req) => req.method === 'PUT' && isFragment(req.url) && fragmentPutNumber() === 4,
      status: 502,
      applyThenFail: true,
    });
    await transport.write('media/ab/resume.bin', big);
    expect(graph.log.some((r) => r.method === 'GET' && isFragment(r.url))).toBe(true);
    expect(await transport.read('media/ab/resume.bin')).toEqual(big);
  });

  it('fails the write when an upload session cannot be resumed or never commits', async () => {
    const isFragment = (url: string) => url.startsWith('https://fake-onedrive-upload.test');
    const big = patterned(10 * 1024 * 1024 + 10); // 4 fragments
    // A 416 whose session status GET fails (expired session): no skipping ahead, no success.
    {
      const { graph, transport } = setup();
      const puts = () => graph.log.filter((r) => r.method === 'PUT' && isFragment(r.url)).length;
      graph.inject({
        match: (req) => req.method === 'PUT' && isFragment(req.url) && puts() === 2,
        status: 416,
      });
      graph.inject({ match: (req) => req.method === 'GET' && isFragment(req.url), status: 404 });
      const err = await errorOf(transport.write('media/ab/expired.bin', big));
      expect(isSyncTransportError(err) && err.code).toBe('UNKNOWN');
      expect(puts()).toBe(2);
      expect(isSyncTransportError(await errorOf(transport.read('media/ab/expired.bin')))).toBe(
        true,
      );
    }
    // The last fragment is answered 202 instead of 200/201: the file was never committed.
    {
      const { graph, transport } = setup();
      const puts = () => graph.log.filter((r) => r.method === 'PUT' && isFragment(r.url)).length;
      graph.inject({
        match: (req) => req.method === 'PUT' && isFragment(req.url) && puts() === 4,
        status: 202,
      });
      const err = await errorOf(transport.write('media/ab/uncommitted.bin', big));
      expect(isSyncTransportError(err) && err.message).toMatch(/ended without completing/);
    }
    // A session that keeps answering 416 at the same offset stops instead of looping.
    {
      const { graph, transport } = setup();
      graph.inject({
        match: (req) => req.method === 'PUT' && isFragment(req.url),
        status: 416,
        times: 100,
      });
      const err = await errorOf(transport.write('media/ab/stalled.bin', big));
      expect(isSyncTransportError(err) && err.message).toMatch(/stopped advancing/);
    }
  });

  it('honors Retry-After on 429 and backs off with jitter on 503', async () => {
    const { graph, sleep, transport } = setup();
    graph.inject({
      match: requestMatches('PUT', 'a.json'),
      status: 429,
      headers: { 'Retry-After': '2' },
    });
    graph.inject({ match: requestMatches('PUT', 'a.json'), status: 503 });
    await transport.write('sync/v1/a.json', new Uint8Array([1]));
    // 429 waits exactly Retry-After; the following 503 uses attempt 1: 1000 ms + 0.5 * 1000 jitter.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 1500]);
    expect(await transport.read('sync/v1/a.json')).toEqual(new Uint8Array([1]));
  });

  it('gives up with RATE_LIMITED after the retry budget or an excessive Retry-After', async () => {
    const { graph, transport } = setup();
    graph.inject({ match: requestMatches('GET', 'children'), status: 429, times: 10 });
    const err = await errorOf(transport.list('sync/v1/'));
    expect(isSyncTransportError(err) && err.code).toBe('RATE_LIMITED');

    const second = setup();
    second.graph.inject({
      match: requestMatches('GET', 'children'),
      status: 429,
      headers: { 'Retry-After': '3600' },
    });
    const longErr = await errorOf(second.transport.list('sync/v1/'));
    expect(isSyncTransportError(longErr) && longErr.code).toBe('RATE_LIMITED');
    expect(second.sleep).not.toHaveBeenCalled();
  });

  it('refreshes the token once on 401, then reports AUTH_REQUIRED', async () => {
    const refreshed = setup({ tokens: ['stale', 'graph-token-1'] });
    await refreshed.transport.write('sync/v1/b.json', new Uint8Array([3]));
    expect(refreshed.auth.getValidAccessToken).toHaveBeenCalledWith({ forceRefresh: true });

    const revoked = setup({ tokens: ['stale', 'still-stale'] });
    const err = await errorOf(revoked.transport.read('sync/v1/b.json'));
    expect(isSyncTransportError(err) && err.code).toBe('AUTH_REQUIRED');
    expect(revoked.auth.getValidAccessToken).toHaveBeenCalledTimes(2);
  });

  it('maps 403 to PERMISSION_DENIED and fetch failures to NETWORK', async () => {
    const { graph, transport } = setup();
    graph.inject({ match: requestMatches('GET', 'children'), status: 403 });
    const denied = await errorOf(transport.list(''));
    expect(isSyncTransportError(denied) && denied.code).toBe('PERMISSION_DENIED');

    const offline = new OneDriveAppFolderTransport({
      auth: createAuth(),
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const netErr = await errorOf(offline.read('sync/v1/manifest.json'));
    expect(isSyncTransportError(netErr) && netErr.code).toBe('NETWORK');
  });

  it('downloads through the pre-authenticated URL without sending the bearer token', async () => {
    const { graph, transport } = setup();
    await transport.write('sync/v1/c.json', new Uint8Array([4, 5]));
    await transport.read('sync/v1/c.json');
    expect(graph.log.some((r) => r.url.startsWith('https://fake-onedrive-download.test'))).toBe(
      true,
    );
    expect(graph.authLeaks).toEqual([]);
  });

  it('rejects unsafe paths before any request', async () => {
    const { graph, transport } = setup();
    await expect(transport.read('../secrets.json')).rejects.toThrow(/Unsafe OneDrive/);
    await expect(transport.write('sync/v1/./x', new Uint8Array())).rejects.toThrow(/Unsafe/);
    expect(graph.log).toHaveLength(0);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('5', 0)).toBe(5000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfterMs('soon', 0)).toBeNull();
    expect(parseRetryAfterMs(null, 0)).toBeNull();
  });

  it('carries a real core sync run: device B pulls what device A pushed', async () => {
    const { createEventFactory, createHlcState } = await import('@flash/core');
    const { runSync } = await import('@flash/core/sync');
    const { transport } = setup();
    const t0 = Date.UTC(2026, 10, 22, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const events = [
      factory.create('PreferencesChanged', { preferences: { day_start_hour: 5 } }, t0),
      factory.create('PreferencesChanged', { preferences: { pinyin_tone_colors: false } }, t0 + 5),
    ];
    const pushed = await runSync({
      transport,
      deviceId: 'dev-a',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 2,
      nowMs: () => t0 + 100,
      getLocalEventsAfterSeq: async (after) => events.filter((e) => e.seq > after),
    });
    expect(pushed.status).toBe('ok');
    expect(pushed.pushedEventCount).toBe(2);

    const pulled = await runSync({
      transport,
      deviceId: 'dev-b',
      cursor: createInitialSyncCursor(),
      localOwnSeq: 0,
      nowMs: () => t0 + 200,
      getLocalEventsAfterSeq: async () => [],
    });
    expect(pulled.status).toBe('ok');
    expect(pulled.pulledEvents.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });
});
