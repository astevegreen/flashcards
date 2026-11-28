import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveNoteId,
  type KnownEvent,
} from '@flash/core';
import { exportFlashpkg } from '@flash/core/flashpkg';
import type { Auth, PlatformServices, Storage } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
// Relative path: the real Drive client (no workspace export), driven by a fake Drive API.
import { WebGoogleSourcesClient } from '../../platform-web/src/sources/google-sheets-docs.ts';
import {
  applyGoogleDriveReconciliation,
  classifyGoogleDriveFile,
  linkGoogleDriveFile,
  refreshGoogleDriveFileRow,
  refreshSingleGoogleDriveFileSource,
  splitPickedGoogleFiles,
} from '../src/sources/googleDriveFileSource.ts';
import {
  loadSourcesRegistry,
  refreshAllSources,
  saveSourcesRegistry,
  unlinkSource,
} from '../src/sources/sourceRunner.ts';

const enc = new TextEncoder();
const CSV_MIME = 'text/csv';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function memoryStorage(): Storage {
  const kv = new Map<string, unknown>();
  return {
    getKv: async <T = unknown>(k: string) => kv.get(k) as T | undefined,
    setKv: async (k: string, v: unknown) => {
      kv.set(k, structuredClone(v));
    },
    deleteKv: async (k: string) => {
      kv.delete(k);
    },
    putMedia: async () => undefined,
  } as unknown as Storage;
}

interface DriveFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  md5: string;
}

/** A tiny Drive v3 `files.get` (metadata + `alt=media`) with a per-file status override. */
class FakeDrive {
  readonly files = new Map<string, DriveFile>();
  readonly status = new Map<string, number>();
  private counter = 0;

  put(id: string, name: string, mimeType: string, body: string | Uint8Array): void {
    this.counter += 1;
    const bytes = typeof body === 'string' ? enc.encode(body) : body;
    this.files.set(id, { name, mimeType, bytes, md5: `md5-${this.counter}` });
  }

  readonly fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    const forced = this.status.get(id);
    if (forced) return new Response('denied', { status: forced });
    const file = this.files.get(id);
    if (!file) return new Response('missing', { status: 404 });
    if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(file.bytes));
    return Response.json({
      id,
      name: file.name,
      mimeType: file.mimeType,
      size: String(file.bytes.byteLength),
      md5Checksum: file.md5,
      webViewLink: `https://drive.google.com/file/d/${id}/view`,
    });
  });

  downloads(): number {
    return this.fetch.mock.calls.filter(([u]) => String(u).includes('alt=media')).length;
  }
}

function setup(options: { connected?: boolean; canParseXlsx?: boolean } = {}) {
  const drive = new FakeDrive();
  drive.put(
    'csv-1',
    'vocab.csv',
    CSV_MIME,
    'word,definition,topic\n나무,tree,nature\n강,river,nature\n',
  );
  let connected = options.connected !== false;
  const auth = {
    isConfigured: () => true,
    isConnected: async () => connected,
    getValidAccessToken: async () => 'tok',
  } as unknown as Auth;
  const client = new WebGoogleSourcesClient({
    auth,
    fetchImpl: drive.fetch,
    sleep: async () => {},
  });
  const state = createEmptyState();
  const factory = createEventFactory('dev-gd', 0, createHlcState('dev-gd', 1000));
  const emitted: KnownEvent[] = [];
  const platform = {
    storage: memoryStorage(),
    googleOAuthConfigured: true,
    getGoogleAuth: async () => auth,
    getGoogleSourcesClient: async () => client,
    getLocalFolderSources: async () => ({
      canParseXlsx: () => options.canParseXlsx !== false,
      parseXlsxBytes: async () => [
        ['word', 'definition'],
        ['달', 'moon'],
      ],
    }),
  } as unknown as PlatformServices;
  const ctx = {
    platform,
    getState: () => state,
    getEventFactory: () => factory,
    emitEvents: (events: readonly KnownEvent[]) => {
      emitted.push(...events);
      applyEvents(state, events);
    },
  };
  return {
    drive,
    ctx,
    state,
    emitted,
    setConnected: (v: boolean) => {
      connected = v;
    },
  };
}

const COLUMN_MAP = [
  { header: 'word', target: 'field:word' },
  { header: 'definition', target: 'field:meaning' },
  { header: 'topic', target: 'tags' },
];
const LINK_OPTIONS = {
  noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
  language: 'ko',
  columnMap: COLUMN_MAP,
};
const CSV_FILE = { id: 'csv-1', name: 'vocab.csv', mimeType: CSV_MIME };

function buildFlashpkg(version: string, words: Array<[string, string]>): Uint8Array {
  const st = createEmptyState();
  const factory = createEventFactory('pkg-author', 0, createHlcState('pkg-author', 1000));
  const deckId = 'drive-pkg-deck';
  applyEvents(st, [
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: 'Drive Pack',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: 1000,
      },
      1000,
    ),
    ...words.map(([word, meaning], idx) =>
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(deckId, word),
          deck_id: deckId,
          source_key: word,
          fields: { word, meaning },
          tags: [],
          provenance: { source: 'import', reviewed: true },
          created_order: idx,
        },
        1000 + idx,
      ),
    ),
  ]);
  return exportFlashpkg(st, { packageId: 'pkg:drive-pack', name: 'Drive Pack', version });
}

describe('picked Google Drive items', () => {
  it('classifies Sheets/Docs, spreadsheet files, packages, and unsupported files', () => {
    expect(classifyGoogleDriveFile('V', 'application/vnd.google-apps.spreadsheet')).toBe('sheet');
    expect(classifyGoogleDriveFile('D', 'application/vnd.google-apps.document')).toBe('doc');
    expect(classifyGoogleDriveFile('S', 'application/vnd.google-apps.presentation')).toBeNull();
    expect(classifyGoogleDriveFile('a.csv', 'application/vnd.ms-excel')).toBe('table');
    expect(classifyGoogleDriveFile('a.TSV', 'text/plain')).toBe('table');
    expect(classifyGoogleDriveFile('a.xlsx', XLSX_MIME)).toBe('table');
    expect(classifyGoogleDriveFile('deck.flashpkg', 'application/octet-stream')).toBe('flashpkg');
    // Old binary Excel can't be read, whatever its MIME type says.
    expect(classifyGoogleDriveFile('old.xls', 'application/vnd.ms-excel')).toBeNull();
    expect(classifyGoogleDriveFile('photo.zip', 'application/zip')).toBeNull();
    // A name without an extension falls back to the MIME type.
    expect(classifyGoogleDriveFile('vocab', CSV_MIME)).toBe('table');

    const split = splitPickedGoogleFiles([
      { id: 's', name: 'Sheet', mimeType: 'application/vnd.google-apps.spreadsheet' },
      { id: 'c', name: 'vocab.csv', mimeType: CSV_MIME },
      { id: 'z', name: 'notes.zip', mimeType: 'application/zip' },
    ]);
    expect(split.workspace.map((f) => f.id)).toEqual(['s']);
    expect(split.files).toEqual([
      { id: 'c', name: 'vocab.csv', mimeType: CSV_MIME, format: 'table' },
    ]);
    expect(split.rejected).toEqual(['notes.zip']);
  });
});

describe('linked Google Drive files (§3.1, drive.file)', () => {
  it('links a .csv with the chosen mapping and records it on the deck source', async () => {
    const { ctx, state, emitted } = setup();
    const res = await linkGoogleDriveFile(CSV_FILE, ctx, LINK_OPTIONS);
    const created = emitted.find((e) => e.type === 'DeckCreated');
    if (created?.type !== 'DeckCreated') throw new Error('no deck');
    expect(created.payload.name).toBe('vocab');
    expect(created.payload.source).toMatchObject({
      kind: 'google_drive_file',
      external_id: 'csv-1',
      read_only: true,
      uri: 'https://drive.google.com/file/d/csv-1/view',
      column_map: COLUMN_MAP,
    });
    expect(res.source).toMatchObject({
      format: 'table',
      lastStatus: 'synced',
      contentTag: 'md5:md5-1',
    });
    const notes = [...state.notes.values()];
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.fields['word'] === '나무')?.tags).toEqual(['nature']);
    const saved = await loadSourcesRegistry(ctx.platform);
    expect(saved.googleDriveFiles).toHaveLength(1);
    expect(saved.googleDriveFiles?.[0]?.columnMap).toEqual(COLUMN_MAP);
  });

  it('skips the download while md5Checksum is unchanged and re-pulls when the file changed', async () => {
    const { drive, ctx, state, emitted } = setup();
    const { source } = await linkGoogleDriveFile(CSV_FILE, ctx, LINK_OPTIONS);
    expect(drive.downloads()).toBe(1);

    emitted.length = 0;
    const same = await refreshSingleGoogleDriveFileSource(source, ctx);
    expect(same.updated).toBe(false);
    expect(drive.downloads()).toBe(1);
    expect(emitted).toEqual([]);

    drive.put(
      'csv-1',
      'vocab.csv',
      CSV_MIME,
      'word,definition,topic\n나무,big tree,nature\n강,river,nature\n산,mountain,nature\n',
    );
    const changed = await refreshSingleGoogleDriveFileSource(source, ctx);
    expect(changed.updated).toBe(true);
    expect(drive.downloads()).toBe(2);
    const byWord = new Map([...state.notes.values()].map((n) => [n.fields['word'], n]));
    expect(byWord.get('나무')?.fields['meaning']).toBe('big tree');
    expect(byWord.get('산')?.archived).toBe(false);
    expect(source.contentTag).toBe('md5:md5-2');
  });

  it('holds a likely rename for review and applies the user’s match', async () => {
    const { drive, ctx, state } = setup();
    const { source } = await linkGoogleDriveFile(CSV_FILE, ctx, LINK_OPTIONS);
    const river = [...state.notes.values()].find((n) => n.fields['word'] === '강');
    if (!river) throw new Error('missing note');

    drive.put(
      'csv-1',
      'vocab.csv',
      CSV_MIME,
      'word,definition,topic\n나무,tree,nature\n강물,river,nature\n',
    );
    const held = await refreshGoogleDriveFileRow(source.id, ctx);
    if (held?.outcome.kind !== 'pending') throw new Error('expected a held pull');
    expect(held.outcome.pending.folderId).toBe('gdrive:csv-1');
    expect(state.notes.get(river.id)?.fields['word']).toBe('강');

    const applied = await applyGoogleDriveReconciliation(
      held.outcome.pending,
      { [river.id]: '강물' },
      ctx,
    );
    expect(applied?.applied).toBe(true);
    expect(state.notes.get(river.id)?.fields['word']).toBe('강물');
    expect(state.notes.get(river.id)?.archived).toBe(false);
  });

  it('asks to reconnect when signed out, and to pick again when access was lost', async () => {
    const { drive, ctx, emitted, setConnected } = setup();
    const { source } = await linkGoogleDriveFile(CSV_FILE, ctx, LINK_OPTIONS);
    emitted.length = 0;

    setConnected(false);
    await refreshSingleGoogleDriveFileSource(source, ctx, { force: true });
    expect(source.lastStatus).toBe('permission_required');
    expect(source.lastError).toMatch(/Connect Google/);

    setConnected(true);
    drive.status.set('csv-1', 403);
    await refreshSingleGoogleDriveFileSource(source, ctx, { force: true });
    expect(source.lastStatus).toBe('permission_required');
    expect(source.lastError).toMatch(/Pick it again/);

    drive.status.set('csv-1', 404);
    await expect(refreshSingleGoogleDriveFileSource(source, ctx, { force: true })).rejects.toThrow(
      /not found in Google Drive/,
    );
    expect(emitted).toEqual([]);
  });

  it('keeps no source behind when the first pull fails, and refuses unsupported files', async () => {
    const { drive, ctx } = setup();
    drive.put('empty', 'empty.csv', CSV_MIME, '');
    await expect(
      linkGoogleDriveFile({ id: 'empty', name: 'empty.csv', mimeType: CSV_MIME }, ctx),
    ).rejects.toThrow(/no column names/);
    expect((await loadSourcesRegistry(ctx.platform)).googleDriveFiles ?? []).toEqual([]);
    await expect(
      linkGoogleDriveFile({ id: 'x', name: 'slides.pptx', mimeType: 'application/zip' }, ctx),
    ).rejects.toThrow(/not a \.csv/);
  });

  it('leaves an .xlsx alone on a device without an Excel reader (no download)', async () => {
    const { drive, ctx } = setup({ canParseXlsx: false });
    drive.put('x-1', 'words.xlsx', XLSX_MIME, new Uint8Array([1, 2, 3]));
    await expect(
      linkGoogleDriveFile({ id: 'x-1', name: 'words.xlsx', mimeType: XLSX_MIME }, ctx),
    ).rejects.toThrow(/Excel files can't be read/);
    expect(drive.downloads()).toBe(0);
  });

  it('links an .xlsx where Excel can be read', async () => {
    const { drive, ctx, state } = setup();
    drive.put('x-2', 'words.xlsx', XLSX_MIME, new Uint8Array([1, 2, 3]));
    await linkGoogleDriveFile({ id: 'x-2', name: 'words.xlsx', mimeType: XLSX_MIME }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
    });
    expect([...state.notes.values()].map((n) => n.fields['word'])).toEqual(['달']);
  });

  it('refreshAllSources refreshes linked Drive files with the Google sources', async () => {
    const { drive, ctx } = setup();
    await linkGoogleDriveFile(CSV_FILE, ctx, LINK_OPTIONS);
    drive.put(
      'csv-1',
      'vocab.csv',
      CSV_MIME,
      'word,definition,topic\n나무,tree,nature\n강,river,nature\n달,moon,sky\n',
    );
    const summary = await refreshAllSources(ctx);
    expect(summary.errors).toEqual([]);
    expect(summary.updatedSources).toBe(1);
    expect(summary.importedNotes).toBe(1);
    expect(summary.registry.googleDriveFiles?.[0]?.lastStatus).toBe('synced');
  });

  it('lists a file linked on another device, and unlinks it everywhere', async () => {
    const { ctx, state, emitted } = setup();
    const { source } = await linkGoogleDriveFile(CSV_FILE, ctx, LINK_OPTIONS);
    // Another device: its registry is empty, but the synced deck carries the Drive source.
    const fresh = { ...ctx.platform, storage: memoryStorage() } as PlatformServices;
    const other = await loadSourcesRegistry(fresh, state);
    expect(other.googleDriveFiles).toMatchObject([
      { fileId: 'csv-1', format: 'table', deckId: source.deckId, name: 'vocab' },
    ]);

    emitted.length = 0;
    const after = await unlinkSource('gdrive_file', source.id, ctx);
    expect(after.googleDriveFiles).toEqual([]);
    expect(emitted.map((e) => e.type)).toEqual(['SourceUnlinked']);
    expect(state.decks.get(source.deckId ?? '')?.source).toBeUndefined();
    expect(state.notes.size).toBe(2);
    // The unlinked deck no longer brings the row back on any device.
    await saveSourcesRegistry(fresh, other);
    expect((await loadSourcesRegistry(fresh, state)).googleDriveFiles).toEqual([]);
  });

  it('links a .flashpkg and re-imports it only when the file changes', async () => {
    const { drive, ctx, state } = setup();
    drive.put(
      'pkg-1',
      'pack.flashpkg',
      'application/octet-stream',
      buildFlashpkg('1.0.0', [['물', 'water']]),
    );
    const { source } = await linkGoogleDriveFile(
      { id: 'pkg-1', name: 'pack.flashpkg', mimeType: 'application/octet-stream' },
      ctx,
    );
    expect(source).toMatchObject({
      format: 'flashpkg',
      name: 'Drive Pack',
      packageId: 'pkg:drive-pack',
      version: '1.0.0',
      lastStatus: 'synced',
    });
    expect(state.decks.get(source.deckId ?? '')?.source).toMatchObject({
      kind: 'google_drive_file',
      external_id: 'pkg-1',
      package_id: 'pkg:drive-pack',
    });
    expect(drive.downloads()).toBe(1);
    await refreshSingleGoogleDriveFileSource(source, ctx);
    expect(drive.downloads()).toBe(1);

    drive.put(
      'pkg-1',
      'pack.flashpkg',
      'application/octet-stream',
      buildFlashpkg('1.1.0', [
        ['물', 'water'],
        ['불', 'fire'],
      ]),
    );
    const res = await refreshSingleGoogleDriveFileSource(source, ctx);
    expect(res.updated).toBe(true);
    expect(source.version).toBe('1.1.0');
    expect([...state.notes.values()].map((n) => n.fields['word']).sort()).toEqual(['물', '불']);
    // The synced deck is listed as a package row on another device.
    const other = await loadSourcesRegistry(
      { ...ctx.platform, storage: memoryStorage() } as PlatformServices,
      state,
    );
    expect(other.googleDriveFiles?.[0]).toMatchObject({ format: 'flashpkg', fileId: 'pkg-1' });
  });

  it('asks before an update archives notes: Cancel writes nothing, Continue applies it (C9)', async () => {
    const { drive, ctx, state, emitted } = setup();
    const PKG = 'application/octet-stream';
    const v1: Array<[string, string]> = [
      ['물', 'water'],
      ['불', 'fire'],
      ['흙', 'earth'],
    ];
    drive.put('pkg-1', 'pack.flashpkg', PKG, buildFlashpkg('1.0.0', v1));
    const answer = vi.fn(async () => false);
    const asking = { ...ctx, confirmArchive: answer };
    const { source } = await linkGoogleDriveFile(
      { id: 'pkg-1', name: 'pack.flashpkg', mimeType: PKG },
      asking,
    );
    expect(answer).not.toHaveBeenCalled();
    drive.put('pkg-1', 'pack.flashpkg', PKG, buildFlashpkg('2.0.0', [['물', 'water']]));
    const words = () =>
      [...state.notes.values()]
        .filter((n) => !n.archived)
        .map((n) => n.fields['word'])
        .sort();

    const written = emitted.length;
    await expect(refreshSingleGoogleDriveFileSource(source, asking)).rejects.toThrow(/cancelled/);
    expect(answer).toHaveBeenCalledWith({
      sourceName: 'Drive Pack',
      notesArchived: 2,
      fileName: 'pack.flashpkg',
    });
    await expect(refreshSingleGoogleDriveFileSource(source, ctx)).rejects.toThrow(/Not updated/);
    expect(emitted).toHaveLength(written);
    expect(source.version).toBe('1.0.0');
    expect(words()).toEqual(['물', '불', '흙']);

    // Re-linking from the picker and saying Cancel isn't a failure: the saved row keeps its status.
    const savedBefore = (await loadSourcesRegistry(ctx.platform, state)).googleDriveFiles?.[0];
    expect(savedBefore?.lastStatus).toBe('synced');
    await expect(
      linkGoogleDriveFile({ id: 'pkg-1', name: 'pack.flashpkg', mimeType: PKG }, asking),
    ).rejects.toThrow(/cancelled/);
    const savedAfter = (await loadSourcesRegistry(ctx.platform, state)).googleDriveFiles?.[0];
    expect(savedAfter?.lastStatus).toBe('synced');
    expect(savedAfter?.lastError).toBeUndefined();
    expect(savedAfter?.version).toBe('1.0.0');
    expect(emitted).toHaveLength(written);

    answer.mockResolvedValue(true);
    await refreshSingleGoogleDriveFileSource(source, asking);
    expect(emitted.slice(written).filter((e) => e.type === 'NoteArchived')).toHaveLength(2);
    expect(source.version).toBe('2.0.0');
    expect(words()).toEqual(['물']);
  });
});
