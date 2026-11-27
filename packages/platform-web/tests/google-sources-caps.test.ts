import { isSyncTransportError } from '@flash/core';
import type { Auth } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_VALUES_JSON_BYTES,
  WebGoogleSourcesClient,
} from '../src/sources/google-sheets-docs.ts';
import { MAX_DRIVE_FILE_BYTES } from '../src/sources/google-drive-files.ts';
import { declaredBody, streamedBody, type OversizedBody } from './helpers/oversized-body.ts';

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

/** A linked .csv/.xlsx file's cap, which a Sheet read must match. */
const LINKED_CSV_CAP = MAX_DRIVE_FILE_BYTES;

const meta = { id: 's1', name: 'Deck', mimeType: 'application/vnd.google-apps.spreadsheet' };

describe('WebGoogleSourcesClient reply caps (P8)', () => {
  it('refuses an oversized metadata reply before reading it', async () => {
    const c = client(() => json(meta, { 'content-length': String(2 * 1024 * 1024) }));
    await expect(c.getFileMetadata('s1')).rejects.toThrow(/file metadata reply exceeds/);
  });

  const values = {
    values: [
      ['Front', 'Back'],
      ['개', 'dog'],
    ],
  };
  const valuesUrls: URL[] = [];
  const sheetClient = (declaredValuesBytes?: number) =>
    client((url) => {
      if (url.hostname === 'www.googleapis.com') return json(meta);
      if (url.pathname.includes('/values/')) {
        valuesUrls.push(url);
        const headers: Record<string, string> =
          declaredValuesBytes === undefined
            ? {}
            : { 'content-length': String(declaredValuesBytes) };
        return json(values, headers);
      }
      return json({ spreadsheetId: 's1', sheets: [{ properties: { title: 'Cards' } }] });
    });

  it('reads a normal sheet-values reply, asking for compact JSON', async () => {
    await expect(sheetClient().readSheet('s1')).resolves.toMatchObject({ values: values.values });
    expect(valuesUrls.at(-1)?.searchParams.get('prettyPrint')).toBe('false');
  });

  it('reads a sheet as big as a linked CSV may be, as JSON (just under the CSV cap)', async () => {
    // 50 MB of CSV made of 1-char cells is about 2x that as JSON; it used to be refused at 50 MB.
    const justUnderAsJson = 2 * (LINKED_CSV_CAP - 1024);
    expect(justUnderAsJson).toBeGreaterThan(LINKED_CSV_CAP);
    await expect(sheetClient(justUnderAsJson).readSheet('s1')).resolves.toMatchObject({
      values: values.values,
    });
  });

  it('still refuses a sheet-values reply clearly over the cap', async () => {
    await expect(sheetClient(MAX_VALUES_JSON_BYTES + 1).readSheet('s1')).rejects.toThrow(
      /sheet values reply exceeds \d+ byte safety limit/,
    );
    await expect(sheetClient(4 * LINKED_CSV_CAP).readSheet('s1')).rejects.toThrow(
      /sheet values reply exceeds/,
    );
  });

  it('caps JSON at no less than the same grid as CSV would need, on representative decks', () => {
    const rows = (row: (i: number) => string[]) => Array.from({ length: 2000 }, (_, i) => row(i));
    const grids = [
      rows((i) => [`word${i}`, `meaning ${i}`, `An example sentence for card ${i}.`]),
      rows(() => ['사랑하다', 'to love', '저는 한국어를 사랑해요.', '동사']),
      rows(() => ['勉強', 'べんきょう', 'study', '日本語を勉強します。']),
      rows(() => Array.from({ length: 26 }, (_, j) => String.fromCodePoint(97 + j))),
      rows(() => Array.from({ length: 26 }, (_, j) => (j === 0 || j === 25 ? 'x' : ''))),
    ];
    const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
    const csvCell = (c: string) => (/[",\r\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c);
    const escapeNonAscii = (s: string) =>
      s.replaceAll(
        /[^ -~]/g, // test data has no control characters, so this is every non-ASCII one
        (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
    for (const grid of grids) {
      const csv = grid.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
      // Compact JSON, also as Google would send it if it escaped every non-ASCII character.
      const asJson = escapeNonAscii(JSON.stringify({ range: "'Cards'!A1:ZZ2000", values: grid }));
      expect(bytes(asJson) / bytes(csv)).toBeLessThanOrEqual(
        MAX_VALUES_JSON_BYTES / LINKED_CSV_CAP,
      );
    }
  });
});

describe('WebGoogleSourcesClient Docs export cap (10 MB)', () => {
  const docMeta = { id: 'd1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' };
  const docClient = (exportReply: () => Response) =>
    client((url) => (url.pathname.endsWith('/export') ? exportReply() : json(docMeta)));

  it('exports a normal Doc as Markdown', async () => {
    const c = docClient(() => new Response('# Notes\n\n- 개 dog\n'));
    await expect(c.exportDocAsMarkdown('d1')).resolves.toMatchObject({
      title: 'Notes',
      markdown: '# Notes\n\n- 개 dog\n',
    });
  });

  it('refuses an export whose Content-Length is over 10 MB', async () => {
    const c = docClient(() => declaredBody(10 * 1024 * 1024 + 1));
    await expect(c.exportDocAsMarkdown('d1')).rejects.toThrow(/Doc export exceeds/);
  });

  it('stops reading a streamed export once it passes 10 MB', async () => {
    let body: OversizedBody | undefined;
    const c = docClient(() => {
      body = streamedBody(64 * 1024 * 1024, 1024 * 1024);
      return body.response;
    });
    await expect(c.exportDocAsMarkdown('d1')).rejects.toThrow(/Doc export exceeds/);
    expect(body?.cancelled).toBe(true);
    expect(body?.pulled).toBeLessThan(16 * 1024 * 1024);
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
