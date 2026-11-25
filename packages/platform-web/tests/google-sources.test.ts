import { isSyncTransportError } from '@flash/core';
import type { Auth, AuthSession } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import {
  extractGoogleAppId,
  GOOGLE_DOC_MIME,
  GOOGLE_SHEET_MIME,
  WebGooglePicker,
  WebGoogleSourcesClient,
} from '../src/sources/google-index.ts';

function makeMockAuth(token = 'tok-1'): Auth & { forceRefreshCalls: number } {
  const auth = {
    forceRefreshCalls: 0,
    isConfigured: () => true,
    isConnected: async () => true,
    getSession: async (): Promise<AuthSession | null> => ({
      provider: 'google',
      accessToken: token,
      expiresAt: Date.now() + 3600_000,
    }),
    getValidAccessToken: async (opts?: { forceRefresh?: boolean }) => {
      if (opts?.forceRefresh) {
        auth.forceRefreshCalls += 1;
        return 'tok-refreshed';
      }
      return token;
    },
    signIn: async () => null,
    handleRedirectCallback: async () => null,
    signOut: async () => {},
  };
  return auth;
}

describe('WebGooglePicker', () => {
  it('extracts numeric GCP appId from Web OAuth clientId', () => {
    expect(extractGoogleAppId('932735219487-abc.apps.googleusercontent.com')).toBe('932735219487');
    expect(extractGoogleAppId('invalid')).toBeUndefined();
  });

  it('opens multi-select Picker for Sheets & Docs and returns picked files', async () => {
    const auth = makeMockAuth('picker-token');
    let capturedCallback:
      | ((data: {
          action?: string;
          docs?: Array<{ id?: string; name?: string; mimeType?: string }>;
        }) => void)
      | null = null;
    const viewsAdded: unknown[] = [];
    let developerKeySet = '';
    let appIdSet = '';

    class FakeDocsView {
      readonly viewId: string;
      constructor(viewId: string) {
        this.viewId = viewId;
      }
      setMimeTypes(): this {
        return this;
      }
    }

    class FakePickerBuilder {
      enableFeature() {
        return this;
      }
      setOAuthToken() {
        return this;
      }
      setDeveloperKey(k: string) {
        developerKeySet = k;
        return this;
      }
      setAppId(a: string) {
        appIdSet = a;
        return this;
      }
      setOrigin() {
        return this;
      }
      addView(v: unknown) {
        viewsAdded.push(v);
        return this;
      }
      setCallback(cb: typeof capturedCallback) {
        capturedCallback = cb;
        return this;
      }
      build() {
        return {
          setVisible: () => {
            capturedCallback?.({
              action: 'picked',
              docs: [
                { id: 'sheet-1', name: 'Korean Vocab', mimeType: GOOGLE_SHEET_MIME },
                { id: 'doc-1', name: 'Grammar Notes', mimeType: GOOGLE_DOC_MIME },
              ],
            });
          },
        };
      }
    }

    const picker = new WebGooglePicker({
      auth,
      apiKey: 'AIzaTestKey',
      clientId: '932735219487-test.apps.googleusercontent.com',
      loadPickerScript: async () => {},
      globals: {
        google: {
          picker: {
            ViewId: { SPREADSHEETS: 'spreadsheets', DOCUMENTS: 'documents' },
            Feature: { MULTISELECT_ENABLED: 'multiselect' },
            Action: { PICKED: 'picked', CANCEL: 'cancel' },
            DocsView: FakeDocsView,
            PickerBuilder: FakePickerBuilder,
          },
        },
        location: { origin: 'https://flashcards.example.com' },
      },
    });

    const picked = await picker.pickSheetsAndDocs();
    expect(developerKeySet).toBe('AIzaTestKey');
    expect(appIdSet).toBe('932735219487');
    expect(viewsAdded).toHaveLength(2);
    expect(picked).toHaveLength(2);
    expect(picked[0]?.id).toBe('sheet-1');
    expect(picked[1]?.id).toBe('doc-1');
  });
});

describe('WebGoogleSourcesClient', () => {
  it('fetches Drive metadata, reads Sheet values with FORMULA, detects embedded images, and writes Card IDs via batchUpdate', async () => {
    const auth = makeMockAuth('tok-init');
    const calls: Array<{ url: string; method: string; body?: string }> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });

      // Simulate 401 on very first call to verify forced refresh retry
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }

      if (url.includes('/drive/v3/files/sheet-42?')) {
        return new Response(
          JSON.stringify({
            id: 'sheet-42',
            name: 'TOPIK I',
            mimeType: GOOGLE_SHEET_MIME,
            modifiedTime: '2026-11-20T12:00:00Z',
            capabilities: { canEdit: true },
          }),
          { status: 200 },
        );
      }

      if (url.includes('/spreadsheets/sheet-42?fields=spreadsheetId')) {
        return new Response(
          JSON.stringify({
            spreadsheetId: 'sheet-42',
            properties: { title: 'TOPIK I' },
            sheets: [{ properties: { title: 'Core Words' } }],
          }),
          { status: 200 },
        );
      }

      if (url.includes('/values/') && url.includes('valueRenderOption=FORMULA')) {
        return new Response(
          JSON.stringify({
            values: [
              ['Word', 'Meaning', 'Image', 'Card ID'],
              ['학교', 'school', '=IMAGE("https://img.example.com/school.png")', ''],
              ['책', 'book', '', 'cid-2'],
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes('includeGridData=true')) {
        return new Response(
          JSON.stringify({
            sheets: [
              {
                data: [
                  {
                    rowData: [
                      {
                        values: [
                          {
                            userEnteredValue: {
                              formulaValue: '=IMAGE("https://img.example.com/school.png")',
                            },
                          },
                        ],
                      },
                      { values: [{ formattedValue: '[Image]' }] },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes(':batchUpdate') && method === 'POST') {
        return new Response(JSON.stringify({ totalUpdatedCells: 1 }), { status: 200 });
      }

      return new Response('Not found', { status: 404 });
    });

    const client = new WebGoogleSourcesClient({
      auth,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
    });

    const grid = await client.readSheet('sheet-42');
    expect(auth.forceRefreshCalls).toBe(1);
    expect(grid.title).toBe('TOPIK I');
    expect(grid.sheetTitle).toBe('Core Words');
    expect(grid.readOnly).toBe(false);
    expect(grid.values[1]?.[2]).toBe('=IMAGE("https://img.example.com/school.png")');
    expect(grid.embeddedImageRows).toEqual([3]);

    await client.writeSheetCells('sheet-42', 'Core Words', [{ a1: 'D2', value: 'new-uuid-1' }]);
    const batchCall = calls.find((c) => c.url.includes(':batchUpdate'));
    expect(batchCall?.body).toBeDefined();
    expect(JSON.parse(batchCall?.body ?? '{}')).toEqual({
      valueInputOption: 'RAW',
      data: [{ range: "'Core Words'!D2", values: [['new-uuid-1']] }],
    });
  });

  it('creates a new Google Sheet from template and exports Google Docs as text/markdown', async () => {
    const auth = makeMockAuth('tok-2');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === 'https://sheets.googleapis.com/v4/spreadsheets' && method === 'POST') {
        return new Response(
          JSON.stringify({
            spreadsheetId: 'created-sheet-9',
            spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/created-sheet-9/edit',
            properties: { title: 'My Korean Sheet' },
            sheets: [{ properties: { title: 'Cards' } }],
          }),
          { status: 200 },
        );
      }

      if (url.includes('/spreadsheets/created-sheet-9/values:batchUpdate')) {
        return new Response(JSON.stringify({ totalUpdatedCells: 7 }), { status: 200 });
      }

      if (url.includes('/drive/v3/files/doc-7?fields=')) {
        return new Response(
          JSON.stringify({
            id: 'doc-7',
            name: 'Korean Particles',
            mimeType: GOOGLE_DOC_MIME,
            modifiedTime: '2026-11-20T13:00:00Z',
            capabilities: { canEdit: true },
          }),
          { status: 200 },
        );
      }

      if (url.includes('/drive/v3/files/doc-7/export?mimeType=text%2Fmarkdown')) {
        return new Response('# Korean Particles\n\nUse 은/는 for topics.', { status: 200 });
      }

      return new Response('Not found', { status: 404 });
    });

    const client = new WebGoogleSourcesClient({
      auth,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
    });

    const created = await client.createSheetFromTemplate({
      title: 'My Korean Sheet',
      headers: ['Word', 'Hanja / Reading', 'Meaning', 'Example', 'Notes', 'Tags', 'Card ID'],
      sampleRows: [['학교', '學校', 'school', '', '', 'sample', '']],
    });
    expect(created.fileId).toBe('created-sheet-9');
    expect(created.uri).toBe('https://docs.google.com/spreadsheets/d/created-sheet-9/edit');

    const doc = await client.exportDocAsMarkdown('doc-7');
    expect(doc.title).toBe('Korean Particles');
    expect(doc.markdown).toContain('# Korean Particles');
    expect(doc.modifiedTime).toBe('2026-11-20T13:00:00Z');
  });
  it('retries a Drive 403 rate limit and reports it as RATE_LIMITED (C22)', async () => {
    const throttled = () =>
      new Response(
        JSON.stringify({ error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } }),
        { status: 403 },
      );
    const sleeps: number[] = [];
    const client = new WebGoogleSourcesClient({
      auth: makeMockAuth(),
      fetchImpl: vi.fn(async () => throttled()),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(client.getFileMetadata('sheet-42')).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'RATE_LIMITED',
    );
    expect(sleeps.length).toBeGreaterThan(0);

    const readOnly = new WebGoogleSourcesClient({
      auth: makeMockAuth(),
      fetchImpl: vi.fn(async () => new Response('Forbidden', { status: 403 })),
      sleep: async () => {},
    });
    await expect(readOnly.getFileMetadata('sheet-42')).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'PERMISSION_DENIED',
    );
  });
});
