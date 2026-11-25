import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveCardId,
  deriveNoteId,
  encodeUtf8,
  type KnownEvent,
} from '@flash/core';
import { exportFlashpkg } from '@flash/core/flashpkg';
import { sha256Hex } from '@flash/core/sources';
import type {
  LocalFolderSourcesAdapter,
  MediaBlob,
  PlatformServices,
  ScannedLocalFileDescriptor,
  Storage,
} from '@flash/platform';
import { describe, expect, it } from 'vitest';
import {
  linkAndScanLocalFolder,
  linkPickedGoogleFiles,
  refreshSingleGoogleSource,
  scanSingleLocalFolder,
} from '../src/sources/sourceRunner.ts';

function makeInMemoryStorage(): Storage & { mediaStore: Map<string, MediaBlob> } {
  const kv = new Map<string, unknown>();
  const mediaStore = new Map<string, MediaBlob>();
  return {
    mediaStore,
    appendEvents: async () => {},
    getEvents: async () => [],
    getEventsForCard: async () => [],
    getAllEvents: async () => [],
    getDeviceEventsAfterSeq: async () => [],
    getEventsAfterLocalSeq: async () => ({ events: [], maxLocalSeq: 0 }),
    getMaxLocalSeq: async () => 0,
    getDeviceMeta: async () => undefined,
    setDeviceMeta: async () => {},
    saveMaterializedCards: async () => {},
    upsertMaterializedCards: async () => {},
    deleteMaterializedCards: async () => {},
    loadMaterializedCards: async () => [],
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
