import type { Auth, AuthSession } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import {
  downloadDriveFileBytes,
  driveContentTag,
  fetchDriveFileInfo,
  GOOGLE_DRIVE_PICKER_MIME_TYPES,
} from '../src/sources/google-drive-files.ts';
import { WebGooglePicker, WebGoogleSourcesClient } from '../src/sources/google-index.ts';

const enc = new TextEncoder();

function makeAuth(): Auth {
  return {
    isConfigured: () => true,
    isConnected: async () => true,
    getSession: async (): Promise<AuthSession | null> => null,
    getValidAccessToken: async (opts?: { forceRefresh?: boolean }) =>
      opts?.forceRefresh ? 'tok-refreshed' : 'tok-1',
    signIn: async () => null,
    handleRedirectCallback: async () => null,
    signOut: async () => {},
  };
}

interface FakeFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  md5Checksum?: string;
  version?: string;
  trashed?: boolean;
  /** Reported size, when it should differ from the bytes (a lying header). */
  reportedSize?: number;
}

/** Minimal Drive v3 `files.get` (metadata and `alt=media`) over a map of files. */
function fakeDrive(files: Record<string, FakeFile>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      calls.push(url.toString());
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      const file = files[id];
      if (!file) return new Response('not found', { status: 404 });
      if (url.searchParams.get('alt') === 'media') {
        return new Response(new Uint8Array(file.bytes), { status: 200 });
      }
      return Response.json({
        id,
        name: file.name,
        mimeType: file.mimeType,
        size: String(file.reportedSize ?? file.bytes.byteLength),
        modifiedTime: '2026-11-20T10:00:00Z',
        ...(file.md5Checksum ? { md5Checksum: file.md5Checksum } : {}),
        ...(file.version ? { version: file.version } : {}),
        webViewLink: `https://drive.google.com/file/d/${id}/view`,
        ...(file.trashed ? { trashed: true } : {}),
      });
    },
  );
  return { fetchImpl, calls };
}

describe('Google Drive plain files (drive.file)', () => {
  it('builds a content tag from md5Checksum, then version, then modifiedTime', () => {
    expect(driveContentTag({ md5Checksum: 'abc', version: '3', modifiedTime: 't' })).toBe(
      'md5:abc',
    );
    expect(driveContentTag({ version: '3', modifiedTime: 't' })).toBe('v:3');
    expect(driveContentTag({ modifiedTime: 't' })).toBe('t:t');
    expect(driveContentTag({})).toBeUndefined();
  });

  it('reads metadata (size, md5, link) and downloads with alt=media', async () => {
    const { fetchImpl, calls } = fakeDrive({
      f1: {
        name: 'vocab.csv',
        mimeType: 'text/csv',
        bytes: enc.encode('word,meaning\n나무,tree\n'),
        md5Checksum: 'm1',
      },
    });
    const info = await fetchDriveFileInfo(fetchImpl, 'f1');
    expect(info).toMatchObject({
      id: 'f1',
      name: 'vocab.csv',
      mimeType: 'text/csv',
      md5Checksum: 'm1',
      contentTag: 'md5:m1',
      webViewLink: 'https://drive.google.com/file/d/f1/view',
    });
    expect(calls[0]).toContain('fields=');
    expect(calls[0]).toContain('md5Checksum');

    const picked = await downloadDriveFileBytes(fetchImpl, 'f1');
    expect(picked.name).toBe('vocab.csv');
    expect(new TextDecoder().decode(picked.bytes)).toContain('나무');
    expect(calls.some((u) => u.includes('alt=media'))).toBe(true);
  });

  it('refuses Google Docs files, trashed files, and files over the size cap', async () => {
    const { fetchImpl, calls } = fakeDrive({
      sheet: {
        name: 'Vocab',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        bytes: new Uint8Array(),
      },
      trashed: { name: 'old.csv', mimeType: 'text/csv', bytes: enc.encode('a'), trashed: true },
      big: {
        name: 'huge.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: new Uint8Array(10),
        reportedSize: 60 * 1024 * 1024,
      },
      liar: { name: 'liar.csv', mimeType: 'text/csv', bytes: new Uint8Array(64), reportedSize: 1 },
    });
    await expect(downloadDriveFileBytes(fetchImpl, 'sheet')).rejects.toThrow(/Google Docs file/);
    await expect(downloadDriveFileBytes(fetchImpl, 'trashed')).rejects.toThrow(/trash/);
    await expect(downloadDriveFileBytes(fetchImpl, 'big')).rejects.toThrow(/50 MB/);
    // Metadata said 1 byte, the body is bigger than the cap: the streamed read still stops.
    await expect(downloadDriveFileBytes(fetchImpl, 'liar', 16)).rejects.toThrow(/50 MB/);
    // None of the refused files except the liar was ever downloaded.
    expect(calls.filter((u) => u.includes('alt=media'))).toHaveLength(1);
  });

  it('WebGoogleSourcesClient exposes the Drive file calls with the shared auth/retry handling', async () => {
    const { fetchImpl } = fakeDrive({
      f2: { name: 'deck.tsv', mimeType: 'text/tab-separated-values', bytes: enc.encode('a\tb') },
    });
    const client = new WebGoogleSourcesClient({
      auth: makeAuth(),
      fetchImpl,
      sleep: async () => {},
    });
    const info = await client.getDriveFileInfo('f2');
    expect(info.contentTag).toBe('t:2026-11-20T10:00:00Z');
    const picked = await client.downloadDriveFile('f2');
    expect(picked.bytes.byteLength).toBe(3);
    // A missing file maps to NOT_FOUND (the runner turns it into "pick it again").
    await expect(client.getDriveFileInfo('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });
});

describe('WebGooglePicker.pickDriveFiles', () => {
  it('opens one Drive view filtered to Sheets, Docs and spreadsheet/package files', async () => {
    const views: Array<{ viewId: string; mimeTypes?: string; folders?: boolean }> = [];
    class FakeDocsView {
      readonly entry: { viewId: string; mimeTypes?: string; folders?: boolean };
      constructor(viewId: string) {
        this.entry = { viewId };
        views.push(this.entry);
      }
      setIncludeFolders(v: boolean) {
        this.entry.folders = v;
        return this;
      }
      setMimeTypes(m: string) {
        this.entry.mimeTypes = m;
        return this;
      }
    }
    type PickedDoc = { id?: string; name?: string; mimeType?: string };
    let callback: ((data: { action?: string; docs?: PickedDoc[] }) => void) | null = null;
    class FakePickerBuilder {
      enableFeature() {
        return this;
      }
      setOAuthToken() {
        return this;
      }
      setDeveloperKey() {
        return this;
      }
      setAppId() {
        return this;
      }
      setOrigin() {
        return this;
      }
      addView() {
        return this;
      }
      setCallback(cb: typeof callback) {
        callback = cb;
        return this;
      }
      build() {
        return {
          setVisible: () =>
            callback?.({
              action: 'picked',
              docs: [{ id: 'csv-1', name: 'vocab.csv', mimeType: 'text/csv' }],
            }),
        };
      }
    }
    const picker = new WebGooglePicker({
      auth: makeAuth(),
      apiKey: 'AIzaTestKey',
      loadPickerScript: async () => {},
      globals: {
        google: {
          picker: {
            ViewId: { SPREADSHEETS: 'spreadsheets', DOCUMENTS: 'documents', DOCS: 'all' },
            Feature: { MULTISELECT_ENABLED: 'multiselect' },
            Action: { PICKED: 'picked', CANCEL: 'cancel' },
            DocsView: FakeDocsView,
            PickerBuilder: FakePickerBuilder,
          },
        },
      },
    });
    const picked = await picker.pickDriveFiles();
    expect(picked).toEqual([{ id: 'csv-1', name: 'vocab.csv', mimeType: 'text/csv' }]);
    expect(views).toHaveLength(1);
    expect(views[0]?.viewId).toBe('all');
    expect(views[0]?.folders).toBe(true);
    expect(views[0]?.mimeTypes?.split(',')).toEqual([...GOOGLE_DRIVE_PICKER_MIME_TYPES]);
  });
});
