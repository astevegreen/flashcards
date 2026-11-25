import { createInitialSyncCursor, isSyncTransportError } from '@flash/core';
import { describe, expect, it } from 'vitest';
import {
  buildDropboxPkceAuthUrl,
  DropboxAppFolderTransport,
} from '../src/sync/dropbox-transport.ts';
import { FakeDropboxServer } from './fakes/fake-dropbox.ts';
import { describeSyncTransportContract } from './helpers/sync-transport-contract.ts';

function setup(options?: { pageSize?: number }) {
  const server = new FakeDropboxServer(options);
  const tokenCalls: Array<{ forceRefresh?: boolean } | undefined> = [];
  const sleeps: number[] = [];
  const transport = new DropboxAppFolderTransport({
    getAccessToken: async (opts) => {
      tokenCalls.push(opts);
      return opts?.forceRefresh ? 'dbx-token-2' : 'dbx-token-1';
    },
    fetchImpl: server.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  return { server, transport, tokenCalls, sleeps };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

describeSyncTransportContract('DropboxAppFolderTransport (fake Dropbox)', () => setup().transport);

describe('DropboxAppFolderTransport (§4.3, §15 Phase 8)', () => {
  it('follows list pagination', async () => {
    const { transport } = setup({ pageSize: 1 });
    await transport.write('sync/v1/manifest.json', new Uint8Array([1]));
    await transport.write('sync/v1/devices/a/head.json', new Uint8Array([2]));
    await transport.write('sync/v1/devices/b/head.json', new Uint8Array([3]));
    expect((await transport.list('sync/v1/')).map((f) => f.path)).toEqual([
      'sync/v1/devices/a/head.json',
      'sync/v1/devices/b/head.json',
      'sync/v1/manifest.json',
    ]);
  });

  it('maps a 409 path/not_found download to NOT_FOUND (real Dropbox, not 404)', async () => {
    const { transport } = setup();
    const err = await errorOf(transport.read('sync/v1/manifest.json'));
    expect(isSyncTransportError(err) && err.code).toBe('NOT_FOUND');
  });

  it('never treats a non-conflict 409 on a write-once upload as success', async () => {
    const { server, transport } = setup();
    server.inject({
      match: (req) => req.url.endsWith('/files/upload'),
      status: 409,
      body: { error_summary: 'path/insufficient_space/..' },
    });
    const err = await errorOf(
      transport.write('sync/v1/devices/a/seg-000001.jsonl.gz', new Uint8Array([1]), {
        ifAbsent: true,
      }),
    );
    expect(isSyncTransportError(err) && err.code).toBe('UNKNOWN');
    expect((err as Error).message).toContain('insufficient_space');
  });

  it('refreshes the token once after a 401 and retries', async () => {
    const { server, transport, tokenCalls } = setup();
    server.put('sync/v1/manifest.json', new Uint8Array([5]));
    let rejected = 0;
    server.inject({
      match: (req) =>
        req.url.endsWith('/files/download') &&
        req.headers['authorization'] === 'Bearer dbx-token-1' &&
        rejected++ === 0,
      status: 401,
      body: { error_summary: 'expired_access_token/' },
    });
    expect(await transport.read('sync/v1/manifest.json')).toEqual(new Uint8Array([5]));
    expect(tokenCalls).toEqual([undefined, { forceRefresh: true }]);
  });

  it('reports AUTH_REQUIRED when the refreshed token is also rejected', async () => {
    const { server, transport } = setup();
    server.inject({
      match: (req) => req.url.endsWith('/files/download'),
      status: 401,
      body: { error_summary: 'invalid_access_token/' },
    });
    const err = await errorOf(transport.read('sync/v1/manifest.json'));
    expect(isSyncTransportError(err) && err.code).toBe('AUTH_REQUIRED');
  });

  it('backs off and retries a 429 instead of failing the sync run', async () => {
    const { server, transport, sleeps } = setup();
    server.put('sync/v1/manifest.json', new Uint8Array([8]));
    let throttled = 0;
    server.inject({
      match: (req) => req.url.endsWith('/files/download') && throttled++ < 2,
      status: 429,
      body: { error_summary: 'too_many_requests/' },
    });
    expect(await transport.read('sync/v1/manifest.json')).toEqual(new Uint8Array([8]));
    expect(sleeps).toHaveLength(2);
  });

  it('rejects unsafe paths before any request', async () => {
    const { transport } = setup();
    await expect(transport.read('../etc/passwd')).rejects.toThrow(/Unsafe Dropbox/);
  });

  it('carries a real core sync run on an empty App Folder: B pulls what A pushed', async () => {
    const { createEventFactory, createHlcState } = await import('@flash/core');
    const { runSync } = await import('@flash/core/sync');
    const { transport } = setup();
    const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);
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

  it('builds an offline PKCE authorization URL', () => {
    const authUrl = buildDropboxPkceAuthUrl({
      clientId: 'dbx-client',
      redirectUri: 'https://app.example/callback',
      codeChallenge: 'challenge-123',
      state: 'state-xyz',
    });
    expect(authUrl).toContain('token_access_type=offline');
    expect(authUrl).toContain('code_challenge_method=S256');
  });
});
