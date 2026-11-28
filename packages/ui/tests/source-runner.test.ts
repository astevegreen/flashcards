import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveCardId,
  deriveNoteId,
  encodeUtf8,
  SyncTransportError,
  withNewDeckCardOrder,
  type CollectionState,
  type KnownEvent,
} from '@flash/core';
import { exportFlashpkg } from '@flash/core/flashpkg';
import { sha256Hex } from '@flash/core/sources';
import type {
  LocalFolderSourcesAdapter,
  MediaBlob,
  PendingXlsxReconciliation,
  PlatformServices,
  SourcesRegistry,
  ScannedLocalFileDescriptor,
  Storage,
} from '@flash/platform';
import { describe, expect, it } from 'vitest';
import type { CloudFileRow } from '../src/sources/cloudFileSource.ts';
import {
  GDRIVE_RECONCILE_PREFIX,
  linkGoogleDriveFile,
  refreshSingleGoogleDriveFileSource,
} from '../src/sources/googleDriveFileSource.ts';
import { hasLinkedSources } from '../src/sources/hasLinkedSources.ts';
import { hasSyncedLinkedSource } from '../src/sources/hasSyncedLinkedSource.ts';
import {
  applyLinkedFileReconciliation,
  createAndLinkGoogleSheetTemplate,
  DROPBOX_RECONCILE_PREFIX,
  LINKED_SOURCES_KV_KEY,
  linkDropboxFile,
  linkOneDriveFile,
  ONEDRIVE_RECONCILE_PREFIX,
  refreshAllSources,
  refreshLinkedFileRow,
  refreshSingleDropboxSource,
  refreshSingleOneDriveSource,
  type SourceRunContext,
  linkAndScanLocalFolder,
  linkPickedGoogleFiles,
  loadSourcesRegistry,
  refreshSingleGoogleSource,
  saveSourcesRegistry,
  scanSingleLocalFolder,
  withSourcesLock,
} from '../src/sources/sourceRunner.ts';

function createEmptySourcesRegistry(): SourcesRegistry {
  return {
    googleSources: [],
    oneDriveSources: [],
    dropboxSources: [],
    localFolders: [],
    packageSubscriptions: [],
    catalogs: [],
  };
}

function makeInMemoryStorage(): Storage & { mediaStore: Map<string, MediaBlob> } {
  const kv = new Map<string, unknown>();
  const mediaStore = new Map<string, MediaBlob>();
  return {
    mediaStore,
    appendEvents: async () => {},
    getAllEvents: async () => [],
    getDeviceEventsAfterSeq: async () => [],
    getEventsAfterLocalSeq: async () => ({ events: [], maxLocalSeq: 0 }),
    getMaxLocalSeq: async () => 0,
    getDeviceMeta: async () => undefined,
    setDeviceMeta: async () => {},
    getSyncCursor: async () => undefined,
    setSyncCursor: async () => {},
    getSyncConfig: async () => undefined,
    setSyncConfig: async () => {},
    getLocalSnapshot: async () => undefined,
    setLocalSnapshot: async () => {},
    getKv: async <T = unknown>(k: string) => kv.get(k) as T | undefined,
    setKv: async (k: string, v: unknown) => {
      kv.set(k, v);
    },
    deleteKv: async (k: string) => {
      kv.delete(k);
    },
    putMedia: async (m: MediaBlob) => {
      mediaStore.set(m.hash, m);
    },
    getMedia: async (hash: string) => mediaStore.get(hash),
    requestPersistence: async () => true,
    clearAll: async () => {
      kv.clear();
      mediaStore.clear();
    },
  };
}

describe('sourceRunner — PC Local Folder end-to-end (relative media, .xlsx reconciliation, Inbox auto-import)', () => {
  it('ingests relative media into Storage.putMedia, auto-imports Inbox/*.flashpkg, and reconciles .xlsx renames', async () => {
    const storage = makeInMemoryStorage();
    const state = createEmptyState();
    const factory = createEventFactory('dev-pc', 0, createHlcState('dev-pc', 1000));

    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const pngHash = sha256Hex(pngBytes);

    const inboxState = createEmptyState();
    const inboxFactory = createEventFactory('ai-cli', 0, createHlcState('ai-cli', 500));
    applyEvents(inboxState, [
      inboxFactory.create(
        'DeckCreated',
        {
          deck_id: 'ai-inbox-deck',
          name: 'AI Inbox Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: 500,
        },
        500,
      ),
      inboxFactory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId('ai-inbox-deck', 'ai-1'),
          deck_id: 'ai-inbox-deck',
          source_key: 'ai-1',
          fields: { word: '인공지능', meaning: 'artificial intelligence' },
          tags: ['ai'],
          provenance: { source: 'ai', reviewed: false },
          created_order: 0,
        },
        500,
      ),
    ]);
    const inboxPkgBytes = exportFlashpkg(inboxState, {
      packageId: 'pkg:ai-inbox-1',
      name: 'AI Inbox Deck',
      version: '1.0.0',
    });

    let xlsxRows: string[][] = [
      ['Word', 'Reading', 'Meaning'],
      ['食べる', 'たべる', 'to eat'],
    ];
    let xlsxMtime = 1000;
    const movedInboxFiles: string[] = [];
    const writtenFiles = new Map<string, string>();

    const localAdapter: LocalFolderSourcesAdapter = {
      isSupported: () => true,
      pickFolder: async () => ({ id: 'folder-1', name: 'My Drive Flashcards' }),
      removeFolder: async () => {},
      ensurePermission: async () => true,
      listFolderFiles: async (): Promise<ScannedLocalFileDescriptor[]> => [
        {
          relativePath: 'korean.csv',
          name: 'korean.csv',
          kind: 'csv',
          isInbox: false,
          size: 40,
          lastModified: 1000,
        },
        {
          relativePath: 'japanese.xlsx',
          name: 'japanese.xlsx',
          kind: 'xlsx',
          isInbox: false,
          size: 50,
          lastModified: xlsxMtime,
        },
        {
          relativePath: 'Inbox/ai-batch.flashpkg',
          name: 'ai-batch.flashpkg',
          kind: 'flashpkg',
          isInbox: true,
          size: inboxPkgBytes.byteLength,
          lastModified: 1000,
        },
      ],
      readFileBytes: async (_fid, relPath) => {
        if (relPath === 'korean.csv') {
          return encodeUtf8('Word,Meaning,Image\n사과,apple,media/apple.png\n');
        }
        if (relPath === 'japanese.xlsx') {
          return encodeUtf8(JSON.stringify(xlsxRows));
        }
        if (relPath === 'Inbox/ai-batch.flashpkg') {
          return inboxPkgBytes;
        }
        throw new Error(`Unexpected file ${relPath}`);
      },
      parseXlsxBytes: async (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as string[][],
      readRelativeMedia: async (_fid, _base, relMedia) => {
        if (relMedia === 'media/apple.png') {
          return { bytes: pngBytes, mime: 'image/png', ext: 'png' };
        }
        return null;
      },
      writeFileText: async (_fid, relPath, text) => {
        writtenFiles.set(relPath, text);
      },
      moveInboxFileToImported: async (_fid, fileName) => {
        movedInboxFiles.push(fileName);
        return true;
      },
    };

    const platform = {
      storage,
      getLocalFolderSources: async () => localAdapter,
    } as unknown as PlatformServices;

    const ctx = {
      platform,
      getState: () => state,
      getEventFactory: () => factory,
      emitEvents: (events: readonly KnownEvent[]) => {
        applyEvents(state, events);
      },
    };

    const linked = await linkAndScanLocalFolder(ctx);
    expect(linked.folder).not.toBeNull();
    if (!linked.folder) return;
    expect(linked.summary?.inboxImported).toBe(1);
    expect(movedInboxFiles).toEqual(['ai-batch.flashpkg']);

    // Relative media stored under sha256 and rewritten to media:<hash> on note
    expect(storage.mediaStore.has(pngHash)).toBe(true);
    expect(state.media.has(pngHash)).toBe(true);
    const koNote = [...state.notes.values()].find((n) => n.fields['word'] === '사과');
    expect(koNote?.fields['image']).toBe(`media:${pngHash}`);

    // CSV Card ID written back to disk
    expect(writtenFiles.get('korean.csv')).toContain('Card ID');

    // AI Inbox note preserved `provenance = { source: 'ai', reviewed: false }` (§10.3)
    const aiNote = [...state.notes.values()].find((n) => n.fields['word'] === '인공지능');
    expect(aiNote?.provenance).toEqual({ source: 'ai', reviewed: false });

    // Review the Japanese .xlsx card once
    const jaDeck = [...state.decks.values()].find((d) => d.name === 'japanese');
    expect(jaDeck).toBeDefined();
    if (!jaDeck) return;
    const eatNoteId = deriveNoteId(jaDeck.id, 'sortkey:食べる');
    const eatCardId = deriveCardId(eatNoteId, 'layout:vocab-ja:recognition', 0);
    applyEvents(state, [
      factory.create(
        'ReviewRecorded',
        {
          review_id: 'rev-xlsx-1',
          card_id: eatCardId,
          rating: 3,
          reviewed_at: 2000,
          tz_offset: 0,
          duration_ms: 400,
          answer_mode: 'flip',
          fsrs_params_version: 0,
          resulting_due_at: 90_000,
        },
        2000,
      ),
    ]);

    // Rename row in .xlsx -> triggers reconciliation prompt
    xlsxRows = [
      ['Word', 'Reading', 'Meaning'],
      ['食べます', 'たべます', 'to eat (polite)'],
    ];
    xlsxMtime = 2000;

    const scan1 = await scanSingleLocalFolder(linked.folder, ctx);
    expect(scan1.pendingReconciliations).toHaveLength(1);
    expect(scan1.pendingReconciliations[0]?.missingNotes[0]?.noteId).toBe(eatNoteId);

    // Apply reconciliation -> preserves eatNoteId and review reps = 1!
    const scan2 = await scanSingleLocalFolder(linked.folder, ctx, {
      xlsxRenameMaps: { 'japanese.xlsx': { [eatNoteId]: '食べます' } },
    });
    expect(scan2.pendingReconciliations).toHaveLength(0);
    expect(state.notes.get(eatNoteId)?.fields['word']).toBe('食べます');
    expect(state.cards.get(eatCardId)?.schedule.reps).toBe(1);

    // An archived deck is left alone, and read again once restored.
    const archive = (archived: boolean, at: number) =>
      applyEvents(state, [
        factory.create('DeckSettingsChanged', { deck_id: jaDeck.id, archived }, at),
      ]);
    archive(true, 3000);
    xlsxRows = [
      ['Word', 'Reading', 'Meaning'],
      ['食べます', 'たべます', 'to eat (changed)'],
    ];
    xlsxMtime = 3000;
    await scanSingleLocalFolder(linked.folder, ctx);
    expect(state.notes.get(eatNoteId)?.fields['meaning']).toBe('to eat (polite)');
    expect(linked.folder.warnings?.some((w) => w.code === 'deck_archived')).toBe(true);

    archive(false, 4000);
    await scanSingleLocalFolder(linked.folder, ctx);
    expect(state.notes.get(eatNoteId)?.fields['meaning']).toBe('to eat (changed)');
  });

  it('localizes CORS-accessible https: images on Google Sheets pull in strictly ascending seq, warns non-blockingly on CORS failure, and reuses cached media without re-fetching on repeat pulls (Option 1)', async () => {
    const storage = makeInMemoryStorage();
    const state = createEmptyState();
    const factory = createEventFactory('dev-pc', 0, createHlcState('dev-pc', 5000));
    const okPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9, 10]);
    const okHash = sha256Hex(okPng);

    let okFetchCount = 0;
    const emittedBatches: KnownEvent[][] = [];

    const platform = {
      storage,
      getGoogleSourcesClient: async () => ({
        getFileMetadata: async () => ({
          id: 'sheet-img-1',
          name: 'Images Sheet',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          modifiedTime: '2026-05-01T10:00:00Z',
          canEdit: false,
        }),
        readSheet: async () => ({
          spreadsheetId: 'sheet-img-1',
          title: 'Images Sheet',
          sheetTitle: 'Sheet1',
          modifiedTime: '2026-05-01T10:00:00Z',
          readOnly: true,
          embeddedImageRows: [],
          values: [
            ['Word', 'Meaning', 'Image', 'Card ID'],
            ['강아지', 'puppy', '=IMAGE("https://cdn.example.com/ok.png")', 'card-1'],
            ['고양이', 'cat', 'https://blocked.example.com/cors.png', 'card-2'],
          ],
        }),
        writeSheetCells: async () => {},
        createSheetFromTemplate: async () => {
          throw new Error('unused');
        },
        exportDocAsMarkdown: async () => ({
          fileId: 'doc-img-1',
          title: 'Doc With Image',
          modifiedTime: '2026-05-01T10:00:00Z',
          markdown: '# Lesson\n\n![Dog](https://cdn.example.com/ok.png)\n',
        }),
      }),
      fetchAndCacheHttpsImage: async (url: string) => {
        if (url === 'https://cdn.example.com/ok.png') {
          okFetchCount += 1;
          return {
            hash: okHash,
            ext: 'png',
            mime: 'image/png',
            size: okPng.byteLength,
            bytes: okPng,
          };
        }
        throw new Error('TypeError: Failed to fetch (CORS blocked)');
      },
    } as unknown as PlatformServices;

    const ctx = {
      platform,
      getState: () => state,
      getEventFactory: () => factory,
      emitEvents: (events: readonly KnownEvent[]) => {
        emittedBatches.push([...events]);
        applyEvents(state, events);
      },
    };

    const sheetSource = {
      id: 'gsheet:sheet-img-1',
      kind: 'google_sheets' as const,
      fileId: 'sheet-img-1',
      name: 'Images Sheet',
      uri: 'https://docs.google.com/spreadsheets/d/sheet-img-1/edit',
    };

    const res = await refreshSingleGoogleSource(sheetSource, ctx, { force: true });

    expect(res.updated).toBe(true);
    expect(okFetchCount).toBe(1);
    expect(storage.mediaStore.has(okHash)).toBe(true);
    expect(state.media.has(okHash)).toBe(true);

    // MediaAdded MUST have strictly lower seq than NoteUpserted in the first batch
    const firstBatch = emittedBatches[0] ?? [];
    const mediaEv = firstBatch.find((e) => e.type === 'MediaAdded');
    const noteEvs = firstBatch.filter((e) => e.type === 'NoteUpserted');
    expect(mediaEv).toBeDefined();
    expect(noteEvs.length).toBeGreaterThan(0);
    if (mediaEv) {
      for (const nEv of noteEvs) {
        expect(mediaEv.seq).toBeLessThan(nEv.seq);
      }
    }

    const puppy = [...state.notes.values()].find((n) => n.fields['word'] === '강아지');
    expect(puppy?.fields['image']).toBe(`media:${okHash}`);

    const cat = [...state.notes.values()].find((n) => n.fields['word'] === '고양이');
    expect(cat?.fields['image']).toBe('https://blocked.example.com/cors.png');
    expect(res.warnings.some((w) => w.code === 'remote_image_cors_blocked')).toBe(true);

    // Second forced pull: cached ok.png URL MUST NOT be re-fetched and MUST NOT emit NoteUpserted diff!
    const res2 = await refreshSingleGoogleSource(sheetSource, ctx, { force: true });
    expect(okFetchCount).toBe(1);
    expect(res2.notesTouched).toBe(0);
    expect(res2.updated).toBe(false);

    // Google Docs image localization: pull 1 localizes, pull 2 reuses cache with changed === false
    const docSource = {
      id: 'gdoc:doc-img-1',
      kind: 'google_docs' as const,
      fileId: 'doc-img-1',
      name: 'Doc With Image',
      uri: 'https://docs.google.com/document/d/doc-img-1/edit',
    };
    const docRes1 = await refreshSingleGoogleSource(docSource, ctx, { force: true });
    expect(docRes1.updated).toBe(true);
    const page = [...state.pages.values()][0];
    expect(page?.markdown).toContain(`media:${okHash}`);
    const fetchesAfterDoc1 = okFetchCount;

    const docRes2 = await refreshSingleGoogleSource(docSource, ctx, { force: true });
    expect(docRes2.updated).toBe(false);
    expect(okFetchCount).toBe(fetchesAfterDoc1);
  });

  it('localizes CORS-accessible https: audio URLs from Google Sheets Audio/Sound 1 columns and reuses cache on repeat pulls', async () => {
    const storage = makeInMemoryStorage();
    const state = createEmptyState();
    const factory = createEventFactory('dev-pc', 0, createHlcState('dev-pc', 9000));
    const okWav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    const okHash = sha256Hex(okWav);
    let audioFetchCount = 0;

    const platform = {
      storage,
      getGoogleSourcesClient: async () => ({
        getFileMetadata: async () => ({
          id: 'sheet-aud-1',
          name: 'Audio Sheet',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          modifiedTime: '2026-05-02T10:00:00Z',
          canEdit: false,
        }),
        readSheet: async () => ({
          spreadsheetId: 'sheet-aud-1',
          title: 'Audio Sheet',
          sheetTitle: 'Sheet1',
          modifiedTime: '2026-05-02T10:00:00Z',
          readOnly: true,
          embeddedImageRows: [],
          values: [
            ['Word', 'Meaning', 'Sound 1', 'Card ID'],
            ['물', 'water', 'https://cdn.example.com/water.wav', 'aud-1'],
            ['불', 'fire', 'https://blocked.example.com/fire.mp3', 'aud-2'],
          ],
        }),
        writeSheetCells: async () => {},
        createSheetFromTemplate: async () => {
          throw new Error('unused');
        },
        exportDocAsMarkdown: async () => {
          throw new Error('unused');
        },
      }),
      fetchAndCacheHttpsAudio: async (url: string) => {
        if (url === 'https://cdn.example.com/water.wav') {
          audioFetchCount += 1;
          return {
            hash: okHash,
            ext: 'wav',
            mime: 'audio/wav',
            size: okWav.byteLength,
            bytes: okWav,
          };
        }
        throw new Error('CORS blocked');
      },
    } as unknown as PlatformServices;

    const ctx = {
      platform,
      getState: () => state,
      getEventFactory: () => factory,
      emitEvents: (events: readonly KnownEvent[]) => {
        applyEvents(state, events);
      },
    };

    const sheetSource = {
      id: 'gsheet:sheet-aud-1',
      kind: 'google_sheets' as const,
      fileId: 'sheet-aud-1',
      name: 'Audio Sheet',
      uri: 'https://docs.google.com/spreadsheets/d/sheet-aud-1/edit',
    };

    const res1 = await refreshSingleGoogleSource(sheetSource, ctx, { force: true });
    expect(res1.updated).toBe(true);
    expect(audioFetchCount).toBe(1);
    expect(storage.mediaStore.has(okHash)).toBe(true);
    const waterNote = [...state.notes.values()].find((n) => n.fields['word'] === '물');
    expect(waterNote?.fields['audio']).toBe(`media:${okHash}`);
    expect(res1.warnings.some((w) => w.code === 'remote_audio_cors_blocked')).toBe(true);

    // Repeat pull reuses cached media:<sha256> with zero additional fetches
    const res2 = await refreshSingleGoogleSource(sheetSource, ctx, { force: true });
    expect(audioFetchCount).toBe(1);
    expect(res2.notesTouched).toBe(0);
  });
});

describe('sourceRunner — Google Sheets column mapping (Bring my cards)', () => {
  it('saves the chosen mapping on the deck source and keeps using it on later refreshes', async () => {
    const state = createEmptyState();
    const factory = createEventFactory('dev-map', 0, createHlcState('dev-map', 9000));
    const emitted: KnownEvent[] = [];
    let modifiedTime = '2026-11-22T10:00:00Z';
    let values = [
      ['word', 'definition', 'category1', 'category2', 'Card ID'],
      ['나무', 'tree', 'nature', 'A1', 'map-1'],
    ];
    const platform = {
      storage: makeInMemoryStorage(),
      getGoogleSourcesClient: async () => ({
        getFileMetadata: async () => ({
          id: 'sheet-map-1',
          name: 'Owner Sheet',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          modifiedTime,
          canEdit: false,
        }),
        readSheet: async () => ({
          spreadsheetId: 'sheet-map-1',
          title: 'Owner Sheet',
          sheetTitle: 'Sheet1',
          modifiedTime,
          readOnly: true,
          embeddedImageRows: [],
          values,
        }),
        writeSheetCells: async () => {},
        createSheetFromTemplate: async () => {
          throw new Error('unused');
        },
        exportDocAsMarkdown: async () => {
          throw new Error('unused');
        },
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
    const columnMap = [
      { header: 'word', target: 'field:word' },
      { header: 'definition', target: 'field:meaning' },
      { header: 'category1', target: 'tags' },
      { header: 'category2', target: 'tags' },
      { header: 'Card ID', target: 'card_id' },
    ];

    const summary = await linkPickedGoogleFiles(
      [
        {
          id: 'sheet-map-1',
          name: 'Owner Sheet',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
      ctx,
      { defaultNoteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, defaultLanguage: 'ko', columnMap },
    );
    expect(summary.errors).toEqual([]);
    const created = emitted.find((e) => e.type === 'DeckCreated');
    if (created?.type !== 'DeckCreated') throw new Error('no deck');
    expect(created.payload.source?.column_map).toEqual(columnMap);
    expect(state.decks.get(created.payload.deck_id)?.source?.column_map).toEqual(columnMap);
    const tree = [...state.notes.values()].find((n) => n.source_key === 'map-1');
    expect(tree?.fields).toEqual({ word: '나무', meaning: 'tree' });
    // The Sheets diff stores tags sorted (as before the mapping step).
    expect(tree?.tags).toEqual(['A1', 'nature']);

    // Another device (a registry entry with no mapping of its own) refreshes after the Sheet
    // changed: the deck's synced mapping still applies, and SourceLinked carries it forward.
    modifiedTime = '2026-11-23T10:00:00Z';
    values = [
      ['word', 'definition', 'category1', 'category2', 'Card ID'],
      ['나무', 'big tree', 'nature', 'A1', 'map-1'],
    ];
    emitted.length = 0;
    await refreshSingleGoogleSource(
      {
        id: 'gsheet:sheet-map-1',
        kind: 'google_sheets',
        fileId: 'sheet-map-1',
        name: 'Owner Sheet',
        uri: 'https://docs.google.com/spreadsheets/d/sheet-map-1/edit',
        deckId: created.payload.deck_id,
      },
      ctx,
      { force: true },
    );
    const relinked = emitted.find((e) => e.type === 'SourceLinked');
    if (relinked?.type !== 'SourceLinked') throw new Error('no SourceLinked');
    expect(relinked.payload.source.column_map).toEqual(columnMap);
    const updated = [...state.notes.values()].find((n) => n.source_key === 'map-1');
    expect(updated?.fields['meaning']).toBe('big tree');
  });
});

describe('sourceRunner — Google Sheets Card ID write-back (D9)', () => {
  it('does not let its own write-back hide a Sheet edit made during the refresh', async () => {
    const state = createEmptyState();
    const factory = createEventFactory('dev-wb', 0, createHlcState('dev-wb', 9000));
    let modifiedTime = '2026-11-25T10:00:00Z';
    let values = [
      ['Word', 'Meaning', 'Card ID'],
      ['나무', 'tree', ''],
    ];
    let writes = 0;
    const platform = {
      storage: makeInMemoryStorage(),
      getGoogleSourcesClient: async () => ({
        getFileMetadata: async () => ({
          id: 'sheet-wb-1',
          name: 'Write-back Sheet',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          modifiedTime,
          canEdit: true,
        }),
        readSheet: async () => ({
          spreadsheetId: 'sheet-wb-1',
          title: 'Write-back Sheet',
          sheetTitle: 'Sheet1',
          modifiedTime,
          readOnly: false,
          embeddedImageRows: [],
          values: values.map((row) => [...row]),
        }),
        writeSheetCells: async (
          _id: string,
          _tab: string,
          updates: { a1: string; value: string }[],
        ) => {
          writes += 1;
          const cardId = updates.find((u) => u.a1.endsWith('2'))?.value ?? '';
          // Our Card ID lands, and the owner edits the meaning while the refresh runs.
          values = [
            ['Word', 'Meaning', 'Card ID'],
            ['나무', 'tree (edited)', cardId],
          ];
          modifiedTime = '2026-11-25T10:05:00Z';
        },
        createSheetFromTemplate: async () => {
          throw new Error('unused');
        },
        exportDocAsMarkdown: async () => {
          throw new Error('unused');
        },
      }),
    } as unknown as PlatformServices;
    const ctx = {
      platform,
      getState: () => state,
      getEventFactory: () => factory,
      emitEvents: (events: readonly KnownEvent[]) => {
        applyEvents(state, events);
      },
    };
    const source = {
      id: 'gsheet:sheet-wb-1',
      kind: 'google_sheets' as const,
      fileId: 'sheet-wb-1',
      name: 'Write-back Sheet',
      uri: 'https://docs.google.com/spreadsheets/d/sheet-wb-1/edit',
    };

    await refreshSingleGoogleSource(source, ctx, { force: true });
    expect(writes).toBe(1);
    const meaning = () =>
      [...state.notes.values()].find((n) => n.fields['word'] === '나무')?.fields['meaning'];
    expect(meaning()).toBe('tree');

    // A normal (unforced) refresh must not short-circuit on the post-write modifiedTime.
    await refreshSingleGoogleSource(source, ctx);
    expect(meaning()).toBe('tree (edited)');
  });
});

describe('sourceRunner — Google Sheets edge cases (C20)', () => {
  function sheetCtx(client: Record<string, unknown>) {
    const state = createEmptyState();
    const factory = createEventFactory('dev-c20', 0, createHlcState('dev-c20', 9000));
    const platform = {
      storage: makeInMemoryStorage(),
      getGoogleSourcesClient: async () => ({
        getFileMetadata: async () => ({
          id: 'sheet-c20',
          name: 'C20 Sheet',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          modifiedTime: '2026-11-25T10:00:00Z',
          canEdit: true,
        }),
        exportDocAsMarkdown: async () => {
          throw new Error('unused');
        },
        ...client,
      }),
    } as unknown as PlatformServices;
    return {
      platform,
      getState: () => state,
      getEventFactory: () => factory,
      emitEvents: (events: readonly KnownEvent[]) => {
        applyEvents(state, events);
      },
    };
  }

  it('keeps a template-created Sheet linked when its first pull fails', async () => {
    const ctx = sheetCtx({
      createSheetFromTemplate: async () => ({
        fileId: 'sheet-c20',
        title: 'New deck',
        sheetTitle: 'Sheet1',
        uri: 'https://docs.google.com/spreadsheets/d/sheet-c20/edit',
      }),
      readSheet: async () => {
        throw new Error('Network down');
      },
      writeSheetCells: async () => {},
    });
    const res = await createAndLinkGoogleSheetTemplate(
      { title: 'New deck', noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, language: 'ko' },
      ctx,
    );
    expect(res.error).toBe('Network down');
    const saved = await loadSourcesRegistry(ctx.platform, ctx.getState());
    expect(saved.googleSources.map((s) => [s.fileId, s.lastStatus, s.lastError])).toEqual([
      ['sheet-c20', 'error', 'Network down'],
    ]);
  });

  it('drops the race bookkeeping when write-back falls back to read-only', async () => {
    let reads = 0;
    const grid = (rows: string[][]) => ({
      spreadsheetId: 'sheet-c20',
      title: 'C20 Sheet',
      sheetTitle: 'Sheet1',
      modifiedTime: '2026-11-25T10:00:00Z',
      readOnly: false,
      embeddedImageRows: [],
      values: rows,
    });
    const ctx = sheetCtx({
      createSheetFromTemplate: async () => {
        throw new Error('unused');
      },
      readSheet: async () => {
        reads += 1;
        // The second (pre-write) read sees another device's Card ID on row 2: a race.
        return grid([
          ['Word', 'Meaning', 'Card ID'],
          ['나무', 'tree', 'kept-id'],
          ['물', 'water', reads === 1 ? '' : 'other-device-id'],
          ['불', 'fire', ''],
        ]);
      },
      writeSheetCells: async () => {
        throw new SyncTransportError('PERMISSION_DENIED', 'view only', 403);
      },
    });
    const source = {
      id: 'gsheet:sheet-c20',
      kind: 'google_sheets' as const,
      fileId: 'sheet-c20',
      name: 'C20 Sheet',
      uri: 'https://docs.google.com/spreadsheets/d/sheet-c20/edit',
    };
    const res = await refreshSingleGoogleSource(source, ctx, { force: true });
    const codes = res.warnings.map((w) => w.code);
    expect(codes).not.toContain('writeback_raced');
    expect(codes.filter((c) => c === 'missing_card_id_readonly')).toHaveLength(2);
    const words = [...ctx.getState().notes.values()].map((n) => n.fields['word']);
    expect(words).toEqual(['나무']);
  });
});

/** One in-memory drive behind all three providers' fakes (OneDrive, Dropbox, Google Drive). */
class FakeCloudDrive {
  files = new Map<string, { name: string; bytes: Uint8Array; tag: number }>();
  connected = true;
  downloads = 0;
  infoCalls = 0;

  put(id: string, name: string, text: string): void {
    const prev = this.files.get(id);
    this.files.set(id, { name, bytes: encodeUtf8(text), tag: (prev?.tag ?? 0) + 1 });
  }

  info(id: string) {
    this.infoCalls += 1;
    const f = this.files.get(id);
    if (!f) throw new Error(`no file ${id}`);
    return { id, name: f.name, size: f.bytes.length, contentTag: `tag-${f.tag}` };
  }

  download(id: string) {
    this.downloads += 1;
    const f = this.files.get(id);
    if (!f) throw new Error(`no file ${id}`);
    return { name: f.name, bytes: f.bytes };
  }
}

interface CloudCase {
  name: string;
  kind: 'onedrive_file' | 'dropbox_file' | 'google_drive_file';
  prefix: string;
  platform(drive: FakeCloudDrive): Partial<PlatformServices>;
  rows(registry: SourcesRegistry): CloudFileRow[] | undefined;
  link(
    file: { id: string; name: string },
    ctx: SourceRunContext,
  ): Promise<{ source: CloudFileRow }>;
  refresh(
    source: CloudFileRow,
    ctx: SourceRunContext,
    opts?: { force?: boolean; renameMap?: Record<string, string> },
  ): Promise<{ pending?: PendingXlsxReconciliation; updated: boolean }>;
}

const LINK_CHOICE = { noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, language: 'ko' };

const CLOUD_CASES: CloudCase[] = [
  {
    name: 'OneDrive',
    kind: 'onedrive_file',
    prefix: ONEDRIVE_RECONCILE_PREFIX,
    platform: (drive) => ({
      oneDriveConfigured: true,
      getOneDrivePicker: async () =>
        ({
          hasFileAccess: async () => drive.connected,
          getFileInfo: async (id: string) => drive.info(id),
          downloadById: async (id: string) => drive.download(id),
        }) as never,
    }),
    rows: (r) => r.oneDriveSources,
    link: (file, ctx) => linkOneDriveFile(file, ctx, LINK_CHOICE),
    refresh: (source, ctx, opts) => refreshSingleOneDriveSource(source as never, ctx, opts),
  },
  {
    name: 'Dropbox',
    kind: 'dropbox_file',
    prefix: DROPBOX_RECONCILE_PREFIX,
    platform: (drive) => ({
      dropboxConfigured: true,
      getDropboxPicker: async () =>
        ({
          isConnected: async () => drive.connected,
          getFileInfo: async (id: string) => ({ ...drive.info(id), pathDisplay: `/Decks/${id}` }),
          downloadById: async (id: string) => drive.download(id),
        }) as never,
    }),
    rows: (r) => r.dropboxSources,
    link: (file, ctx) => linkDropboxFile(file, ctx, LINK_CHOICE),
    refresh: (source, ctx, opts) => refreshSingleDropboxSource(source as never, ctx, opts),
  },
  {
    name: 'Google Drive',
    kind: 'google_drive_file',
    prefix: GDRIVE_RECONCILE_PREFIX,
    platform: (drive) => ({
      googleOAuthConfigured: true,
      getGoogleAuth: async () => ({ isConnected: async () => drive.connected }) as never,
      getGoogleSourcesClient: async () =>
        ({
          getDriveFileInfo: async (id: string) => ({ ...drive.info(id), mimeType: 'text/csv' }),
          downloadDriveFile: async (id: string) => ({ ...drive.download(id), mime: 'text/csv' }),
        }) as never,
    }),
    rows: (r) => r.googleDriveFiles,
    link: (file, ctx) => linkGoogleDriveFile({ ...file, mimeType: 'text/csv' }, ctx, LINK_CHOICE),
    refresh: (source, ctx, opts) => refreshSingleGoogleDriveFileSource(source as never, ctx, opts),
  },
];

function cloudSetup(c: CloudCase) {
  const drive = new FakeCloudDrive();
  drive.put('file-1', 'vocab.csv', 'word,meaning\n나무,tree\n강,river\n');
  const state = createEmptyState();
  const factory = createEventFactory('dev-cloud', 0, createHlcState('dev-cloud', 1000));
  const emitted: KnownEvent[] = [];
  const platform = {
    storage: makeInMemoryStorage(),
    getLocalFolderSources: async () => ({ canParseXlsx: () => true }),
    ...c.platform(drive),
  } as unknown as PlatformServices;
  const ctx: SourceRunContext = {
    platform,
    getState: () => state,
    getEventFactory: () => factory,
    emitEvents: (events) => {
      emitted.push(...events);
      applyEvents(state, events);
    },
  };
  const upserts = () => emitted.filter((e) => e.type === 'NoteUpserted').length;
  return { drive, state, emitted, ctx, upserts };
}

const FILE = { id: 'file-1', name: 'vocab.csv' };

describe.each(CLOUD_CASES)('merged cloud-file runner — $name (R4)', (c) => {
  it('links into one deck, skips the download while unchanged, and re-pulls a change', async () => {
    const { drive, state, ctx, upserts } = cloudSetup(c);
    const { source } = await c.link(FILE, ctx);
    const deck = state.decks.get(source.deckId ?? '');
    expect(deck?.source).toMatchObject({ kind: c.kind, external_id: 'file-1', read_only: true });
    expect(upserts()).toBe(2);
    expect(drive.downloads).toBe(1);

    const same = await c.refresh(source, ctx);
    expect(same.updated).toBe(false);
    expect(drive.downloads).toBe(1);
    expect(source.lastStatus).toBe('synced');

    drive.put('file-1', 'vocab.csv', 'word,meaning\n나무,tree\n강,river\n산,mountain\n');
    const changed = await c.refresh(source, ctx);
    expect(changed.updated).toBe(true);
    expect(drive.downloads).toBe(2);
    expect(upserts()).toBe(3);
  });

  it('links a new deck on the Settings card order, as the app emits it', async () => {
    const { state, ctx, emitted } = cloudSetup(c);
    const pref = createEventFactory('prefs', 0, createHlcState('prefs', 500)).create(
      'PreferencesChanged',
      { preferences: { study_order: 'random' } },
      500,
    );
    applyEvents(state, [pref]);
    // AppContext.emitEvents runs every local batch through withNewDeckCardOrder.
    const appCtx: SourceRunContext = {
      ...ctx,
      emitEvents: (events) => ctx.emitEvents(withNewDeckCardOrder(state, events)),
    };
    const { source } = await c.link(FILE, appCtx);
    expect(state.decks.get(source.deckId ?? '')?.settings.new_card_order).toBe('random');
    const create = emitted.find((e) => e.type === 'DeckCreated');
    expect(create?.payload).toMatchObject({ settings: { new_card_order: 'random' } });
  });

  it('leaves a file whose deck is archived alone, before any network call', async () => {
    const { drive, state, ctx } = cloudSetup(c);
    const { source } = await c.link(FILE, ctx);
    const deck = state.decks.get(source.deckId ?? '');
    if (!deck) throw new Error('missing deck');
    deck.archived = true;
    const calls = drive.infoCalls;
    await c.refresh(source, ctx, { force: true });
    expect(drive.infoCalls).toBe(calls);
    expect(source).toMatchObject({ lastStatus: 'idle', skipReason: 'archived' });
    await expect(c.link(FILE, ctx)).rejects.toThrow(/archived\. Restore it in the Library first/);
  });

  it('holds a likely rename for review, then applies the chosen match', async () => {
    const { drive, state, ctx } = cloudSetup(c);
    const { source } = await c.link(FILE, ctx);
    drive.put('file-1', 'vocab.csv', 'word,meaning\n나모,tree\n강,river\n');
    const held = await c.refresh(source, ctx);
    expect(held.pending?.folderId).toBe(`${c.prefix}file-1`);
    const missing = held.pending?.missingNotes[0];
    if (!missing) throw new Error('no rename candidate');
    const applied = await c.refresh(source, ctx, {
      force: true,
      renameMap: { [missing.noteId]: '나모' },
    });
    expect(applied.updated).toBe(true);
    expect(state.notes.get(missing.noteId)?.archived).toBe(false);
  });

  it('marks the row when the provider is disconnected, and Refresh all says why', async () => {
    const { drive, ctx } = cloudSetup(c);
    await c.link(FILE, ctx);
    drive.connected = false;
    const summary = await refreshAllSources(ctx, { force: true });
    const row = c.rows(summary.registry)?.[0];
    expect(row?.lastStatus).toBe('permission_required');
    expect(row?.lastError).toBeTruthy();
    expect(summary.skipped).toEqual([`vocab: ${row?.lastError}`]);
    expect(summary.errors).toEqual([]);
  });

  it('runs two concurrent refreshes one after the other, applying the change once (D8)', async () => {
    const { drive, ctx, upserts } = cloudSetup(c);
    await c.link(FILE, ctx);
    drive.put('file-1', 'vocab.csv', 'word,meaning\n나무,tree\n강,river\n달,moon\n');
    const before = upserts();
    const [first, second] = await Promise.all([refreshAllSources(ctx), refreshAllSources(ctx)]);
    expect(first.updatedSources + second.updatedSources).toBe(1);
    expect(upserts() - before).toBe(1);
    expect(drive.downloads).toBe(2);
  });
});

describe('launch check for linked sources (hasAny)', () => {
  it('is false for no registry or empty lists, true when any list has a source', () => {
    expect(hasLinkedSources(undefined)).toBe(false);
    expect(hasLinkedSources(createEmptySourcesRegistry())).toBe(false);
    expect(hasLinkedSources({ googleSources: [] })).toBe(false);
    const lists = [
      'googleSources',
      'oneDriveSources',
      'dropboxSources',
      'googleDriveFiles',
      'localFolders',
      'packageSubscriptions',
      'catalogs',
    ] as const;
    for (const key of lists) {
      expect(hasLinkedSources({ ...createEmptySourcesRegistry(), [key]: [{}] })).toBe(true);
    }
  });

  it('is true right after linking a file, as read back from storage', async () => {
    const dropbox = CLOUD_CASES[1];
    if (!dropbox) throw new Error('missing case');
    const { ctx } = cloudSetup(dropbox);
    await dropbox.link(FILE, ctx);
    const saved = await ctx.platform.storage.getKv<SourcesRegistry>(LINKED_SOURCES_KV_KEY);
    expect(hasLinkedSources(saved)).toBe(true);
  });

  it.each(CLOUD_CASES)(
    'hasSyncedLinkedSource is true when a synced $name deck carries its source',
    async (c) => {
      const { state, ctx } = cloudSetup(c);
      expect(hasSyncedLinkedSource(state)).toBe(false);
      const { source } = await c.link(FILE, ctx);
      // Another device synced the deck but never opened Sources: its registry is empty, and
      // loading it rebuilds the row from the deck, so the launch check must refresh.
      expect(hasSyncedLinkedSource(state)).toBe(true);
      const fresh = await loadSourcesRegistry(
        { ...ctx.platform, storage: makeInMemoryStorage() },
        state,
      );
      expect(hasLinkedSources(fresh)).toBe(true);
      const deck = state.decks.get(source.deckId ?? '');
      if (!deck) throw new Error('missing deck');
      deck.archived = true;
      expect(hasSyncedLinkedSource(state)).toBe(false);
    },
  );
});

describe('Refresh all with Google disconnected (linked Drive files)', () => {
  const drive = CLOUD_CASES[2];
  if (!drive) throw new Error('missing case');

  /** A saved Sheet row whose deck is in the collection, and a saved Doc row. */
  async function withSheetAndDoc(ctx: SourceRunContext, state: CollectionState) {
    const factory = ctx.getEventFactory();
    ctx.emitEvents([
      factory.create(
        'DeckCreated',
        {
          deck_id: 'deck-sheet-1',
          name: 'Sheet One',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          source: { kind: 'google_sheets', external_id: 'sheet-1', read_only: false },
          created_at: 1000,
        },
        1000,
      ),
    ]);
    const registry = await loadSourcesRegistry(ctx.platform, state);
    registry.googleSources = [
      {
        id: 'gsheet:sheet-1',
        kind: 'google_sheets',
        fileId: 'sheet-1',
        name: 'Sheet One',
        uri: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        deckId: 'deck-sheet-1',
        lastStatus: 'synced',
      },
      {
        id: 'gdoc:doc-1',
        kind: 'google_docs',
        fileId: 'doc-1',
        name: 'Doc One',
        uri: 'https://docs.google.com/document/d/doc-1/edit',
        lastStatus: 'synced',
      },
    ];
    await saveSourcesRegistry(ctx.platform, registry);
  }

  it('keeps an archived Sheet’s reason, and still marks the Doc', async () => {
    const { drive: fake, ctx, state } = cloudSetup(drive);
    await withSheetAndDoc(ctx, state);
    const deck = state.decks.get('deck-sheet-1');
    if (!deck) throw new Error('missing deck');
    deck.archived = true;
    fake.connected = false;
    const summary = await refreshAllSources(ctx, { force: true });
    const [sheet, doc] = summary.registry.googleSources;
    expect(sheet).toMatchObject({ lastStatus: 'idle', skipReason: 'archived' });
    expect(sheet?.lastError).toMatch(/archived/);
    expect(doc).toMatchObject({ lastStatus: 'permission_required' });
    expect(summary.skipped).toEqual([
      `Sheet One: ${sheet?.lastError}`,
      'Doc One: Connect Google to refresh this file.',
    ]);
  });

  it('marks no Sheet or Doc in a build without Google', async () => {
    const { ctx, state } = cloudSetup(drive);
    await withSheetAndDoc(ctx, state);
    const noGoogle: SourceRunContext = {
      ...ctx,
      platform: {
        ...ctx.platform,
        googleOAuthConfigured: false,
        getGoogleAuth: async () => {
          throw new Error('Google is not configured in this build.');
        },
      } as PlatformServices,
    };
    const summary = await refreshAllSources(noGoogle, { force: true });
    expect(summary.registry.googleSources.map((s) => [s.lastStatus, s.lastError])).toEqual([
      ['synced', undefined],
      ['synced', undefined],
    ]);
    expect(summary.skipped).toEqual([]);
  });

  it('says why each Sheet and Doc was not refreshed, with the Drive row message', async () => {
    const { drive: fake, ctx, state } = cloudSetup(drive);
    await drive.link(FILE, ctx);
    const registry = await loadSourcesRegistry(ctx.platform, state);
    registry.googleSources.push(
      {
        id: 'gsheet:sheet-1',
        kind: 'google_sheets',
        fileId: 'sheet-1',
        name: 'Sheet One',
        uri: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        lastStatus: 'synced',
      },
      {
        id: 'gdoc:doc-1',
        kind: 'google_docs',
        fileId: 'doc-1',
        name: 'Doc One',
        uri: 'https://docs.google.com/document/d/doc-1/edit',
        lastStatus: 'synced',
      },
    );
    await saveSourcesRegistry(ctx.platform, registry);
    fake.connected = false;
    const summary = await refreshAllSources(ctx, { force: true });
    const message = 'Connect Google to refresh this file.';
    expect(summary.registry.googleSources.map((s) => [s.lastStatus, s.lastError])).toEqual([
      ['permission_required', message],
      ['permission_required', message],
    ]);
    expect(summary.registry.googleDriveFiles?.[0]?.lastError).toBe(message);
    expect(summary.skipped).toEqual([
      `Sheet One: ${message}`,
      `Doc One: ${message}`,
      `vocab: ${message}`,
    ]);
    expect(summary.errors).toEqual([]);
  });

  it('keeps an archived deck’s reason instead of asking to connect Google', async () => {
    const { drive: fake, state, ctx } = cloudSetup(drive);
    const { source } = await drive.link(FILE, ctx);
    const deck = state.decks.get(source.deckId ?? '');
    if (!deck) throw new Error('missing deck');
    deck.archived = true;
    fake.connected = false;
    const summary = await refreshAllSources(ctx, { force: true });
    const row = summary.registry.googleDriveFiles?.[0];
    expect(row).toMatchObject({ skipReason: 'archived' });
    expect(row?.lastStatus).not.toBe('permission_required');
    expect(row?.lastError).toMatch(/archived/);
    expect(summary.skipped).toEqual([`vocab: ${row?.lastError}`]);
  });

  it('marks nothing in a build without Google', async () => {
    const { ctx } = cloudSetup(drive);
    const { source } = await drive.link(FILE, ctx);
    const before = { ...source };
    const noGoogle: SourceRunContext = {
      ...ctx,
      platform: {
        ...ctx.platform,
        googleOAuthConfigured: false,
        getGoogleAuth: async () => {
          throw new Error('Google is not configured in this build.');
        },
      } as PlatformServices,
    };
    const summary = await refreshAllSources(noGoogle, { force: true });
    const row = summary.registry.googleDriveFiles?.[0];
    expect(row?.lastStatus).toBe(before.lastStatus);
    expect(row?.lastError).toBeUndefined();
    expect(summary.skipped).toEqual([]);
    expect(summary.errors).toEqual([]);
  });
});

const ROW_KINDS = {
  OneDrive: 'onedrive',
  Dropbox: 'dropbox',
  'Google Drive': 'gdrive_file',
} as const;

describe.each(CLOUD_CASES)('Sources panel row routing — $name', (c) => {
  const rowKind = ROW_KINDS[c.name as keyof typeof ROW_KINDS];

  it('refreshLinkedFileRow refreshes the right row and says what happened', async () => {
    const { drive, ctx } = cloudSetup(c);
    const { source } = await c.link(FILE, ctx);
    const same = await refreshLinkedFileRow(rowKind, source.id, ctx);
    expect(same?.outcome).toEqual({
      kind: 'ok',
      updated: false,
      message: '"vocab" is already up to date.',
    });
    drive.put('file-1', 'vocab.csv', 'word,meaning\n나무,tree\n강,river\n산,mountain\n');
    const changed = await refreshLinkedFileRow(rowKind, source.id, ctx);
    expect(changed?.outcome).toMatchObject({ kind: 'ok', updated: true });
    expect(c.rows(changed?.registry ?? createEmptySourcesRegistry())?.[0]?.lastStatus).toBe(
      'synced',
    );
    expect(await refreshLinkedFileRow(rowKind, 'missing-row', ctx)).toBeNull();
  });

  it('applyLinkedFileReconciliation applies a held rename through the same provider', async () => {
    const { drive, state, ctx } = cloudSetup(c);
    await c.link(FILE, ctx);
    drive.put('file-1', 'vocab.csv', 'word,meaning\n나모,tree\n강,river\n');
    const held = await refreshLinkedFileRow(rowKind, `${c.prefix}file-1`, ctx);
    if (held?.outcome.kind !== 'pending') throw new Error('expected a held rename');
    const rec = held.outcome.pending;
    expect(rec.folderId).toBe(`${c.prefix}file-1`);
    const missing = rec.missingNotes[0];
    if (!missing) throw new Error('no rename candidate');
    const res = await applyLinkedFileReconciliation(rec, { [missing.noteId]: '나모' }, ctx);
    expect(res).toMatchObject({
      applied: true,
      message: `Applied the ${c.name} changes to "${rec.deckName}".`,
    });
    expect(state.notes.get(missing.noteId)?.archived).toBe(false);
    expect(
      await applyLinkedFileReconciliation({ ...rec, folderId: 'local-folder-1' }, {}, ctx),
    ).toBeUndefined();
  });

  it('linking without access keeps no row when no deck exists yet', async () => {
    const { drive, ctx, state } = cloudSetup(c);
    drive.connected = false;
    await expect(c.link(FILE, ctx)).rejects.toThrow();
    const registry = await loadSourcesRegistry(ctx.platform, state);
    expect(c.rows(registry) ?? []).toEqual([]);
    expect(state.decks.size).toBe(0);
  });

  it('linking again without access marks the existing row as needing permission', async () => {
    const { drive, ctx, state } = cloudSetup(c);
    await c.link(FILE, ctx);
    drive.connected = false;
    await expect(c.link(FILE, ctx)).rejects.toThrow();
    const registry = await loadSourcesRegistry(ctx.platform, state);
    const row = c.rows(registry)?.[0];
    expect(row?.lastStatus).toBe('permission_required');
    expect(row?.lastError).toBeTruthy();
    expect(row?.deckId).toBeTruthy();
  });

  it('linking again when the file is gone still marks the existing row as an error', async () => {
    const { drive, ctx, state } = cloudSetup(c);
    await c.link(FILE, ctx);
    drive.files.delete('file-1');
    await expect(c.link(FILE, ctx)).rejects.toThrow();
    const row = c.rows(await loadSourcesRegistry(ctx.platform, state))?.[0];
    expect(row?.lastStatus).toBe('error');
  });

  it('a lost-access row drops an archived reason that no longer applies', async () => {
    const { drive, state, ctx } = cloudSetup(c);
    const { source } = await c.link(FILE, ctx);
    const deck = state.decks.get(source.deckId ?? '');
    if (!deck) throw new Error('missing deck');
    deck.archived = true;
    await c.refresh(source, ctx, { force: true });
    expect(source.skipReason).toBe('archived');
    deck.archived = false;
    drive.connected = false;
    await c.refresh(source, ctx, { force: true });
    expect(source.lastStatus).toBe('permission_required');
    expect(source.skipReason).toBeUndefined();
  });

  it('applyLinkedFileReconciliation finds the row inside the lock (null once it is gone)', async () => {
    const { drive, state, ctx } = cloudSetup(c);
    await c.link(FILE, ctx);
    drive.put('file-1', 'vocab.csv', 'word,meaning\n나모,tree\n강,river\n');
    const held = await refreshLinkedFileRow(rowKind, `${c.prefix}file-1`, ctx);
    if (held?.outcome.kind !== 'pending') throw new Error('expected a held rename');
    const rec = held.outcome.pending;
    // An unlink already holding the lock wins: the reconciliation must not see the old row.
    const unlink = withSourcesLock(async () => {
      const registry = await loadSourcesRegistry(ctx.platform, state);
      const deck = state.decks.get(rec.deckId);
      if (deck) delete deck.source;
      const rows = c.rows(registry);
      rows?.splice(0, rows.length);
      await saveSourcesRegistry(ctx.platform, registry);
    });
    const res = await applyLinkedFileReconciliation(rec, {}, ctx);
    await unlink;
    expect(res).toBeNull();
  });
});

describe('local folder .xlsx on a device that cannot read Excel', () => {
  it('leaves the file alone before reading it, says why, and reads it once it can', async () => {
    let canParse = false;
    const reads: string[] = [];
    const rows = [
      ['Word', 'Meaning'],
      ['나무', 'tree'],
    ];
    const adapter = {
      isSupported: () => true,
      pickFolder: async () => ({ id: 'folder-x', name: 'Decks' }),
      removeFolder: async () => {},
      ensurePermission: async () => true,
      listFolderFiles: async (): Promise<ScannedLocalFileDescriptor[]> => [
        {
          relativePath: 'words.xlsx',
          name: 'words.xlsx',
          kind: 'xlsx',
          isInbox: false,
          size: 10,
          lastModified: 1000,
        },
      ],
      readFileBytes: async (_fid: string, relPath: string) => {
        reads.push(relPath);
        return encodeUtf8(JSON.stringify(rows));
      },
      canParseXlsx: () => canParse,
      parseXlsxBytes: async (bytes: Uint8Array) =>
        JSON.parse(new TextDecoder().decode(bytes)) as string[][],
      readRelativeMedia: async () => null,
      writeFileText: async () => {},
      moveInboxFileToImported: async () => true,
    } as unknown as LocalFolderSourcesAdapter;
    const state = createEmptyState();
    const factory = createEventFactory('dev-x', 0, createHlcState('dev-x', 1000));
    const ctx: SourceRunContext = {
      platform: {
        storage: makeInMemoryStorage(),
        getLocalFolderSources: async () => adapter,
      } as unknown as PlatformServices,
      getState: () => state,
      getEventFactory: () => factory,
      emitEvents: (events) => applyEvents(state, events),
    };

    const linked = await linkAndScanLocalFolder(ctx);
    if (!linked.folder) throw new Error('no folder');
    expect(reads).toEqual([]);
    expect(state.decks.size).toBe(0);
    expect(linked.folder.warnings).toEqual([
      {
        code: 'xlsx_unreadable',
        message: `Excel files can't be read on this device. Save "words.xlsx" as CSV in Excel and link that instead.`,
        file: 'words.xlsx',
      },
    ]);

    canParse = true;
    await scanSingleLocalFolder(linked.folder, ctx);
    expect(reads).toEqual(['words.xlsx']);
    expect(state.decks.size).toBe(1);
  });
});
