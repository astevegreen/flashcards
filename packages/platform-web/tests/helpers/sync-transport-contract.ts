import { isSyncTransportError } from '@flash/core';
import type { SyncTransport } from '@flash/platform';
import { describe, expect, it } from 'vitest';
import type { FaultyFetch, TokenIssuer } from './faulty-fetch.ts';

/** A transport plus, for HTTP transports, a way to make its next requests fail. */
export interface SyncTransportHarness {
  transport: SyncTransport;
  faults?: FaultyFetch;
  /** The token source the fake checks; expiring it makes the next request a real 401. */
  tokens?: TokenIssuer;
  /** The provider reports throttling as 403 + a rate-limit reason (Google, C22). */
  throttlesWith403?: boolean;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

/**
 * Shared §4.3 `SyncTransport` contract suite. Any transport (in-memory, OneDrive, …) runs the same
 * behavioral checks the sync engine relies on: binary-safe round trips, prefix listing in
 * code-unit order, write-once `ifAbsent` -> `ALREADY_EXISTS`, overwrite, and `NOT_FOUND` reads.
 * HTTP transports also pass `faults`: a 401 refreshes once and then is AUTH_REQUIRED, and a
 * 429 (or Google's 403 rate limit) is retried and then is RATE_LIMITED, never a reconnect.
 */
export function describeSyncTransportContract(
  name: string,
  create: () =>
    Promise<SyncTransport | SyncTransportHarness> | SyncTransport | SyncTransportHarness,
): void {
  const harness = async (): Promise<SyncTransportHarness> => {
    const made = await create();
    return 'transport' in made ? made : { transport: made };
  };
  const createTransport = async () => (await harness()).transport;
  describe(`SyncTransport contract: ${name}`, () => {
    it('round-trips binary payloads byte-for-byte', async () => {
      const transport = await createTransport();
      const payload = new Uint8Array([0, 255, 10, 13, 0x1f, 0x8b, 128]);
      await transport.write('sync/v1/devices/a/seg-000001.jsonl.gz', payload, { ifAbsent: true });
      expect(await transport.read('sync/v1/devices/a/seg-000001.jsonl.gz')).toEqual(payload);
    });

    it('lists by prefix across nested folders in code-unit order', async () => {
      const transport = await createTransport();
      const bytes = new Uint8Array([1]);
      await transport.write('sync/v1/manifest.json', bytes);
      await transport.write('sync/v1/devices/b/head.json', bytes);
      await transport.write('sync/v1/devices/a/head.json', bytes);
      await transport.write('sync/v1/devices/a/seg-000001.jsonl.gz', new Uint8Array([1, 2, 3]));
      await transport.write('media/ab/abcd.png', bytes);

      const all = await transport.list('sync/v1/');
      expect(all.map((f) => f.path)).toEqual([
        'sync/v1/devices/a/head.json',
        'sync/v1/devices/a/seg-000001.jsonl.gz',
        'sync/v1/devices/b/head.json',
        'sync/v1/manifest.json',
      ]);
      expect(all.find((f) => f.path.endsWith('seg-000001.jsonl.gz'))?.size).toBe(3);

      const partial = await transport.list('sync/v1/devices/a/seg-');
      expect(partial.map((f) => f.path)).toEqual(['sync/v1/devices/a/seg-000001.jsonl.gz']);
      expect((await transport.list('media/')).map((f) => f.path)).toEqual(['media/ab/abcd.png']);
    });

    it('returns an empty list for a prefix nothing was written under', async () => {
      const transport = await createTransport();
      expect(await transport.list('sync/v1/devices/')).toEqual([]);
    });

    it('rejects ifAbsent writes over an existing file with ALREADY_EXISTS', async () => {
      const transport = await createTransport();
      const first = new Uint8Array([7, 7]);
      await transport.write('sync/v1/devices/a/seg-000002.jsonl.gz', first, { ifAbsent: true });
      const err = await transport
        .write('sync/v1/devices/a/seg-000002.jsonl.gz', new Uint8Array([9]), { ifAbsent: true })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(isSyncTransportError(err) && err.code).toBe('ALREADY_EXISTS');
      expect(await transport.read('sync/v1/devices/a/seg-000002.jsonl.gz')).toEqual(first);
    });

    it('overwrites mutable files (head.json) without ifAbsent', async () => {
      const transport = await createTransport();
      await transport.write('sync/v1/devices/a/head.json', new TextEncoder().encode('{"seq":1}'));
      await transport.write('sync/v1/devices/a/head.json', new TextEncoder().encode('{"seq":2}'));
      const text = new TextDecoder().decode(await transport.read('sync/v1/devices/a/head.json'));
      expect(text).toBe('{"seq":2}');
    });

    it('reports NOT_FOUND for a missing file', async () => {
      const transport = await createTransport();
      const err = await transport.read('sync/v1/devices/zz/head.json').then(
        () => null,
        (e: unknown) => e,
      );
      expect(isSyncTransportError(err) && err.code).toBe('NOT_FOUND');
    });

    it('refreshes once after a 401, then reports AUTH_REQUIRED', async (ctx) => {
      const { transport, faults } = await harness();
      if (!faults) return ctx.skip();
      const bytes = new Uint8Array([4, 2]);
      await transport.write('sync/v1/manifest.json', bytes);
      faults.failNext(401, 1);
      expect(await transport.read('sync/v1/manifest.json')).toEqual(bytes);
      faults.failNext(401, 2);
      const err = await errorOf(transport.read('sync/v1/manifest.json'));
      expect(isSyncTransportError(err) && err.code).toBe('AUTH_REQUIRED');
    });

    it('force-refreshes an expired token and retries with the new one', async (ctx) => {
      const { transport, tokens } = await harness();
      if (!tokens) return ctx.skip();
      const bytes = new Uint8Array([4, 2, 1]);
      await transport.write('sync/v1/manifest.json', bytes);
      const before = tokens.forcedRefreshes;
      tokens.expireAll();
      // The fake now rejects every token handed out so far: only a forced refresh can pass.
      expect(await transport.read('sync/v1/manifest.json')).toEqual(bytes);
      expect(tokens.forcedRefreshes).toBe(before + 1);
      // The new token stays good: the next call needs no refresh.
      await transport.write('sync/v1/manifest.json', bytes);
      expect(tokens.forcedRefreshes).toBe(before + 1);
    });

    it('retries a 429, then reports RATE_LIMITED', async (ctx) => {
      const { transport, faults } = await harness();
      if (!faults) return ctx.skip();
      const bytes = new Uint8Array([4, 2, 9]);
      await transport.write('sync/v1/manifest.json', bytes);
      faults.failNext(429, 1);
      expect(await transport.read('sync/v1/manifest.json')).toEqual(bytes);
      faults.failNext(429, 20);
      const err = await errorOf(transport.read('sync/v1/manifest.json'));
      expect(isSyncTransportError(err) && err.code).toBe('RATE_LIMITED');
    });

    it('treats a 403 rate limit as RATE_LIMITED, not PERMISSION_DENIED', async (ctx) => {
      const { transport, faults, throttlesWith403 } = await harness();
      if (!faults || !throttlesWith403) return ctx.skip();
      await transport.write('sync/v1/manifest.json', new Uint8Array([1]));
      faults.failNext('403-rate', 20);
      const err = await errorOf(transport.read('sync/v1/manifest.json'));
      expect(isSyncTransportError(err) && err.code).toBe('RATE_LIMITED');
    });
  });
}
