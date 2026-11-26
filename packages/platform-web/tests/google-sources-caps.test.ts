import { isSyncTransportError } from '@flash/core';
import type { Auth } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import { WebGoogleSourcesClient } from '../src/sources/google-sheets-docs.ts';

const auth = {
  getValidAccessToken: async () => 'token',
} as unknown as Auth;

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function client(route: (url: URL) => Response, sleeps: number[] = []) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
    route(new URL(typeof input === 'string' ? input : input.toString())),
  );
  return new WebGoogleSourcesClient({
    auth,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
}

const meta = { id: 's1', name: 'Deck', mimeType: 'application/vnd.google-apps.spreadsheet' };

describe('WebGoogleSourcesClient reply caps (P8)', () => {
  it('refuses an oversized metadata reply before reading it', async () => {
    const c = client(() => json(meta, { 'content-length': String(2 * 1024 * 1024) }));
    await expect(c.getFileMetadata('s1')).rejects.toThrow(/file metadata reply exceeds/);
  });

  it('refuses a sheet-values reply over 50 MB but reads a normal one', async () => {
    const values = {
      values: [
        ['Front', 'Back'],
        ['개', 'dog'],
      ],
    };
    const route = (oversized: boolean) => (url: URL) => {
      if (url.hostname === 'www.googleapis.com') return json(meta);
      if (url.pathname.includes('/values/')) {
        return json(values, oversized ? { 'content-length': String(51 * 1024 * 1024) } : {});
      }
      return json({ spreadsheetId: 's1', sheets: [{ properties: { title: 'Cards' } }] });
    };
    await expect(client(route(false)).readSheet('s1')).resolves.toMatchObject({
      values: values.values,
    });
    await expect(client(route(true)).readSheet('s1')).rejects.toThrow(/sheet values reply exceeds/);
  });
});

describe('WebGoogleSourcesClient Retry-After ceiling', () => {
  it('waits out a short Retry-After but fails fast on a long one (a user is waiting)', async () => {
    const throttled = (retryAfter: string) =>
      new Response('{}', { status: 429, headers: { 'Retry-After': retryAfter } });

    const sleeps: number[] = [];
    let calls = 0;
    const short = client(() => (calls++ === 0 ? throttled('1') : json(meta)), sleeps);
    await expect(short.getFileMetadata('s1')).resolves.toMatchObject({ id: 's1' });
    expect(sleeps).toEqual([1000]);

    const longSleeps: number[] = [];
    const long = client(() => throttled('20'), longSleeps);
    const err = await long.getFileMetadata('s1').catch((e: unknown) => e);
    expect(isSyncTransportError(err) && err.code).toBe('RATE_LIMITED');
    expect(longSleeps).toEqual([]);
  });
});
