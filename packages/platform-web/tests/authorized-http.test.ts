import { isSyncTransportError } from '@flash/core';
import { describe, expect, it, vi } from 'vitest';
import { AuthorizedHttpClient } from '../src/sync/authorized-http.ts';
import { createGoogleFetch } from '../src/sync/google-http.ts';

type Scripted = number | { status: number; body: unknown };

function scripted(statuses: Scripted[]) {
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('Authorization') ?? '');
    const next = statuses.shift() ?? 200;
    const { status, body } = typeof next === 'number' ? { status: next, body: {} } : next;
    return new Response(JSON.stringify(body), { status });
  });
  return { fetchImpl, seen };
}

const auth = {
  getValidAccessToken: async (opts?: { forceRefresh?: boolean }) =>
    opts?.forceRefresh ? 't2' : 't1',
};
const rateLimited403: Scripted = {
  status: 403,
  body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
};

describe('AuthorizedHttpClient (R1)', () => {
  it('does not count the 401 refresh as a retry attempt', async () => {
    const { fetchImpl, seen } = scripted([401, 429, 503]);
    const sleeps: number[] = [];
    const client = new AuthorizedHttpClient(
      {
        auth,
        fetchImpl,
        maxAttempts: 3,
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      'Test',
    );
    expect((await client.send('https://example.test/x')).status).toBe(200);
    expect(seen).toEqual(['Bearer t1', 'Bearer t2', 'Bearer t2', 'Bearer t2']);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('retries what isRetryable accepts, with the configured base delay', async () => {
    const { fetchImpl } = scripted([418, 200]);
    const sleeps: number[] = [];
    const client = new AuthorizedHttpClient(
      {
        auth,
        fetchImpl,
        baseDelayMs: 100,
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        isRetryable: (res) => res.status === 418,
      },
      'Test',
    );
    expect((await client.send('https://example.test/x')).status).toBe(200);
    expect(sleeps).toEqual([100]);
  });
});

describe('createGoogleFetch (C22)', () => {
  const make = (statuses: Scripted[]) =>
    createGoogleFetch({
      auth,
      fetchImpl: scripted(statuses).fetchImpl,
      sleep: async () => {},
      label: 'Google API',
      messages: { authRequired: 'reconnect', permissionDenied: 'denied', notFound: 'gone' },
    });
  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => (isSyncTransportError(e) ? e.code : 'other'),
    );

  it('retries a 403 rate limit and maps a lasting one to RATE_LIMITED', async () => {
    expect((await make([rateLimited403, 200])('https://g.test')).status).toBe(200);
    const lasting = make([rateLimited403, rateLimited403, rateLimited403]);
    expect(await codeOf(lasting('https://g.test'))).toBe('RATE_LIMITED');
  });

  it('maps a plain 403, a 404, a second 401 and a lasting 5xx', async () => {
    expect(await codeOf(make([403])('https://g.test'))).toBe('PERMISSION_DENIED');
    expect(await codeOf(make([404])('https://g.test'))).toBe('NOT_FOUND');
    expect(await codeOf(make([401, 401])('https://g.test'))).toBe('AUTH_REQUIRED');
    expect(await codeOf(make([503, 503, 503])('https://g.test'))).toBe('NETWORK');
  });
});
