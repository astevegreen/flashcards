import { isSyncTransportError } from '@flash/core';
import { describe, expect, it, vi } from 'vitest';
import { DropboxAppFolderFilePicker } from '../src/sources/dropbox-picker.ts';
import { GraphOneDriveFilePicker } from '../src/sources/onedrive-picker.ts';
import { FakeDropboxServer } from './fakes/fake-dropbox.ts';
import { FAKE_DOWNLOAD_ORIGIN, FakeGraphServer } from './fakes/fake-graph.ts';
import { declaredBody, streamedBody, type OversizedBody } from './helpers/oversized-body.ts';

/**
 * Per-call-site limits of the Dropbox and OneDrive pickers: a download whose body outgrows the
 * cap (the metadata said it was small) is refused while streaming, and a user-facing request
 * waits out a `Retry-After` of up to 2 s but fails fast on a longer one.
 */

const enc = new TextEncoder();
const CAP = 1024;
const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

type Override = (url: string) => Response | undefined;

function dropbox(override: Override, sleeps: number[] = []) {
  const server = new FakeDropboxServer();
  server.put('Decks/korean.csv', enc.encode('Front,Back\n개,dog\n'), 1_700_000_000_000);
  const fetchImpl: typeof fetch = (input, init) =>
    Promise.resolve(override(urlOf(input)) ?? server.fetch(input, init));
  const picker = new DropboxAppFolderFilePicker({
    auth: {
      isConfigured: () => true,
      isConnected: async () => true,
      getValidAccessToken: async () => 'dbx-token-1',
      signIn: vi.fn(async () => null),
    },
    fetchImpl,
    maxBytes: CAP,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  return { server, picker };
}

function oneDrive(override: Override, sleeps: number[] = []) {
  const graph = new FakeGraphServer();
  graph.drive.put('Decks/korean.csv', enc.encode('Front,Back\n개,dog\n'), 1_700_000_000_000);
  const fetchImpl: typeof fetch = (input, init) =>
    Promise.resolve(override(urlOf(input)) ?? graph.fetch(input, init));
  const picker = new GraphOneDriveFilePicker({
    auth: {
      isConfigured: () => true,
      getValidAccessToken: async () => 'graph-token-1',
      hasScope: async () => true,
      signIn: vi.fn(async () => null),
    },
    fetchImpl,
    maxBytes: CAP,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const csvId = graph.drive.files.get('Decks/korean.csv')?.id ?? '';
  return { graph, picker, csvId };
}

const throttled = (retryAfter: string) =>
  new Response(JSON.stringify({ error_summary: 'too_many_requests/' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': retryAfter },
  });

/** Answers the first request matching `match` with a 429 carrying `retryAfter`, or every one. */
function throttleOnce(match: string, retryAfter: string, always = false): Override {
  let sent = false;
  return (url) => {
    if (!url.includes(match) || (sent && !always)) return undefined;
    sent = true;
    return throttled(retryAfter);
  };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('Dropbox picker download cap', () => {
  it('stops reading a body that outgrows the cap the metadata passed', async () => {
    let body: OversizedBody | undefined;
    const { picker } = dropbox((url) => {
      if (!url.endsWith('/files/download')) return undefined;
      body = streamedBody(CAP * 64, 256);
      return body.response;
    });
    await expect(picker.downloadById('/Decks/korean.csv')).rejects.toThrow(/50 MB import limit/);
    expect(body?.cancelled).toBe(true);
    expect(body?.pulled).toBeLessThan(CAP * 4);
  });

  it('refuses a download whose Content-Length is over the cap', async () => {
    const { picker } = dropbox((url) =>
      url.endsWith('/files/download') ? declaredBody(CAP + 1) : undefined,
    );
    await expect(picker.downloadById('/Decks/korean.csv')).rejects.toThrow(/50 MB import limit/);
  });
});

describe('OneDrive picker download cap', () => {
  it('stops reading a body that outgrows the cap the metadata passed', async () => {
    let body: OversizedBody | undefined;
    const { picker, csvId } = oneDrive((url) => {
      if (!url.startsWith(FAKE_DOWNLOAD_ORIGIN)) return undefined;
      body = streamedBody(CAP * 64, 256);
      return body.response;
    });
    await expect(picker.downloadById(csvId)).rejects.toThrow(/50 MB import limit/);
    expect(body?.cancelled).toBe(true);
    expect(body?.pulled).toBeLessThan(CAP * 4);
  });

  it('refuses a download whose Content-Length is over the cap', async () => {
    const { picker, csvId } = oneDrive((url) =>
      url.startsWith(FAKE_DOWNLOAD_ORIGIN) ? declaredBody(CAP + 1) : undefined,
    );
    await expect(picker.downloadById(csvId)).rejects.toThrow(/50 MB import limit/);
  });
});

describe('interactive Retry-After ceiling (2 s) in the pickers', () => {
  it('Dropbox waits out a 2 s Retry-After', async () => {
    const sleeps: number[] = [];
    const { picker } = dropbox(throttleOnce('/files/list_folder', '2'), sleeps);
    const items = await picker.listFolder('/Decks');
    expect(items.map((i) => i.name)).toEqual(['korean.csv']);
    expect(sleeps).toEqual([2000]);
  });

  it('Dropbox fails fast on a Retry-After over 2 s', async () => {
    const sleeps: number[] = [];
    const { picker } = dropbox(throttleOnce('/files/list_folder', '3', true), sleeps);
    const err = await errorOf(picker.listFolder('/Decks'));
    expect(isSyncTransportError(err) && err.code).toBe('RATE_LIMITED');
    expect(sleeps).toEqual([]);
  });

  it('OneDrive waits out a 2 s Retry-After', async () => {
    const sleeps: number[] = [];
    const { picker } = oneDrive(throttleOnce('/root/children', '2'), sleeps);
    const items = await picker.listFolder();
    expect(items.map((i) => i.name)).toEqual(['Decks']);
    expect(sleeps).toEqual([2000]);
  });

  it('OneDrive fails fast on a Retry-After over 2 s', async () => {
    const sleeps: number[] = [];
    const { picker } = oneDrive(throttleOnce('/root/children', '3', true), sleeps);
    const err = await errorOf(picker.listFolder());
    expect(isSyncTransportError(err) && err.code).toBe('RATE_LIMITED');
    expect(sleeps).toEqual([]);
  });
});
