import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type KnownEvent,
} from '@flash/core';
import type { PlatformServices, Storage } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
// Relative paths: the fake Graph lives with the platform-web tests (no workspace export).
import { GraphOneDriveFilePicker } from '../../platform-web/src/sources/onedrive-picker.ts';
import { FakeGraphServer } from '../../platform-web/tests/fakes/fake-graph.ts';
import {
  linkOneDriveFile,
  loadSourcesRegistry,
  refreshAllSources,
  readOneDriveTable,
  refreshSingleOneDriveSource,
  saveSourcesRegistry,
} from '../src/sources/sourceRunner.ts';

const enc = new TextEncoder();

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
  } as unknown as Storage;
}

function setup(options: { hasFilesRead?: boolean } = {}) {
  const graph = new FakeGraphServer();
  graph.drive.put(
    'Decks/vocab.csv',
    enc.encode('word,definition,topic\n나무,tree,nature\n강,river,nature\n'),
    1_700_000_000_000,
  );
  const fetchSpy = vi.fn(graph.fetch);
  const auth = {
    isConfigured: () => true,
    getValidAccessToken: async () => 'graph-token-1',
    hasScope: async () => options.hasFilesRead !== false,
    signIn: async () => null,
  };
  const picker = new GraphOneDriveFilePicker({ auth, fetchImpl: fetchSpy, sleep: async () => {} });
  const state = createEmptyState();
  const factory = createEventFactory('dev-od', 0, createHlcState('dev-od', 1000));
  const emitted: KnownEvent[] = [];
  const platform = {
    storage: memoryStorage(),
    oneDriveConfigured: true,
    getOneDrivePicker: async () => picker,
    getLocalFolderSources: async () => ({
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
  const downloads = () =>
    fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('https://fake-onedrive-download'))
      .length;
  const fileId = () => {
    const found = graph.drive.files.get('Decks/vocab.csv');
    if (!found) throw new Error('missing file');
    return found.id;
  };
  return { graph, ctx, state, emitted, downloads, fileId };
}

const COLUMN_MAP = [
  { header: 'word', target: 'field:word' },
  { header: 'definition', target: 'field:meaning' },
  { header: 'topic', target: 'tags' },
];

describe('linked OneDrive sources (§15 Phase 12)', () => {
  it('links a .csv with the chosen column mapping and records it on the deck source', async () => {
    const { ctx, state, emitted, fileId } = setup();
    const res = await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    expect(res.source.deckId).toBeTruthy();
    const created = emitted.find((e) => e.type === 'DeckCreated');
    if (created?.type !== 'DeckCreated') throw new Error('no deck');
    expect(created.payload.name).toBe('vocab');
    expect(created.payload.source).toMatchObject({
      kind: 'onedrive_file',
      external_id: fileId(),
      read_only: true,
      column_map: COLUMN_MAP,
    });
    const notes = [...state.notes.values()];
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.fields['word'] === '나무')?.tags).toEqual(['nature']);
    const saved = await loadSourcesRegistry(ctx.platform);
    expect(saved.oneDriveSources).toHaveLength(1);
    expect(saved.oneDriveSources?.[0]?.columnMap).toEqual(COLUMN_MAP);
  });

  it('skips the download when the content tag is unchanged, and re-pulls when the file changed', async () => {
    const { graph, ctx, state, emitted, downloads, fileId } = setup();
    const { source } = await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    expect(downloads()).toBe(1);

    emitted.length = 0;
    const same = await refreshSingleOneDriveSource(source, ctx);
    expect(same.updated).toBe(false);
    expect(downloads()).toBe(1);
    expect(emitted).toEqual([]);

    // One row edited, one added (a removal plus an addition is held for review, see below).
    graph.drive.put(
      'Decks/vocab.csv',
      enc.encode(
        'word,definition,topic\n나무,big tree,nature\n강,river,nature\n산,mountain,nature\n',
      ),
      1_700_000_100_000,
    );
    const changed = await refreshSingleOneDriveSource(source, ctx);
    expect(changed.updated).toBe(true);
    expect(downloads()).toBe(2);
    const relinked = emitted.find((e) => e.type === 'SourceLinked');
    if (relinked?.type !== 'SourceLinked') throw new Error('no SourceLinked');
    expect(relinked.payload.source.column_map).toEqual(COLUMN_MAP);
    const byWord = new Map([...state.notes.values()].map((n) => [n.fields['word'], n]));
    expect(byWord.get('나무')?.fields['meaning']).toBe('big tree');
    expect(byWord.get('강')?.archived).toBe(false);
    expect(byWord.get('산')?.archived).toBe(false);
    expect(source.lastStatus).toBe('synced');
  });

  it('asks for file access instead of failing when Files.Read is not granted', async () => {
    const { ctx, emitted, fileId } = setup({ hasFilesRead: false });
    const source = {
      id: `onedrive:${fileId()}`,
      itemId: fileId(),
      name: 'vocab',
      lastStatus: 'idle' as const,
    };
    const res = await refreshSingleOneDriveSource(source, ctx, { force: true });
    expect(res.updated).toBe(false);
    expect(source.lastStatus).toBe('permission_required');
    expect(emitted).toEqual([]);
  });

  it('keeps no source behind when the first pull fails', async () => {
    const { graph, ctx } = setup();
    graph.drive.put('Decks/empty.csv', enc.encode(''), 1);
    const id = graph.drive.files.get('Decks/empty.csv')?.id ?? '';
    await expect(linkOneDriveFile({ id, name: 'empty.csv' }, ctx)).rejects.toThrow(
      /no column names/,
    );
    const saved = await loadSourcesRegistry(ctx.platform);
    expect(saved.oneDriveSources).toEqual([]);
  });

  it('refuses a file that is not a spreadsheet', async () => {
    const { ctx } = setup();
    await expect(linkOneDriveFile({ id: 'x', name: 'deck.flashpkg' }, ctx)).rejects.toThrow(
      /not a \.csv/,
    );
  });

  it('refreshAllSources refreshes linked OneDrive files and reports the changes', async () => {
    const { graph, ctx, fileId } = setup();
    await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    graph.drive.put(
      'Decks/vocab.csv',
      enc.encode('word,definition,topic\n나무,tree,nature\n강,river,nature\n달,moon,sky\n'),
      1_700_000_200_000,
    );
    const summary = await refreshAllSources(ctx);
    expect(summary.errors).toEqual([]);
    expect(summary.importedNotes).toBe(1);
    expect(summary.registry.oneDriveSources?.[0]?.lastStatus).toBe('synced');
  });

  it('surfaces a OneDrive deck synced from another device as a linked source', async () => {
    const { ctx, state, fileId } = setup();
    const factory = createEventFactory('dev-other', 0, createHlcState('dev-other', 1));
    applyEvents(state, [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'deck-od',
          name: 'Synced',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          source: { kind: 'onedrive_file', external_id: fileId(), read_only: true },
          created_at: 1,
        },
        1,
      ),
    ]);
    const registry = await loadSourcesRegistry(ctx.platform, state);
    expect(registry.oneDriveSources).toMatchObject([
      { itemId: fileId(), deckId: 'deck-od', name: 'Synced' },
    ]);
  });
});

describe('linked OneDrive sources: review fixes', () => {
  it('holds a likely rename for the reconciliation prompt instead of archiving the note', async () => {
    const { graph, ctx, state, emitted, fileId } = setup();
    const { source } = await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    const old = [...state.notes.values()].find((n) => n.fields['word'] === '나무');
    if (!old) throw new Error('missing note');

    // A typo fix in the first field of one row.
    graph.drive.put(
      'Decks/vocab.csv',
      enc.encode('word,definition,topic\n나모,tree,nature\n강,river,nature\n'),
      1_700_000_300_000,
    );
    emitted.length = 0;
    const tagBefore = source.contentTag;
    const held = await refreshSingleOneDriveSource(source, ctx);
    expect(emitted).toEqual([]);
    expect(held.updated).toBe(false);
    expect(source.contentTag).toBe(tagBefore);
    expect(held.pending).toMatchObject({
      folderId: `onedrive:${fileId()}`,
      relativePath: 'vocab.csv',
      deckName: 'vocab',
    });
    const [missing] = held.pending?.missingNotes ?? [];
    const [added] = held.pending?.addedRows ?? [];
    expect(missing?.noteId).toBe(old.id);

    // The user matches the renamed row: same note, review history kept, nothing archived.
    const applied = await refreshSingleOneDriveSource(source, ctx, {
      force: true,
      renameMap: { [old.id]: added?.sortKey ?? '' },
    });
    expect(applied.pending).toBeUndefined();
    const after = state.notes.get(old.id);
    expect(after?.fields['word']).toBe('나모');
    expect(after?.archived).toBe(false);
    expect([...state.notes.values()].filter((n) => !n.archived)).toHaveLength(2);
  });

  it('applies an unmatched rename (archive and add) once the user chose that', async () => {
    const { graph, ctx, state, fileId } = setup();
    const { source } = await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    graph.drive.put(
      'Decks/vocab.csv',
      enc.encode('word,definition,topic\n나모,tree,nature\n강,river,nature\n'),
      1_700_000_300_000,
    );
    await refreshSingleOneDriveSource(source, ctx, { force: true, renameMap: {} });
    const byWord = new Map([...state.notes.values()].map((n) => [n.fields['word'], n]));
    expect(byWord.get('나무')?.archived).toBe(true);
    expect(byWord.get('나모')?.archived).toBe(false);
  });

  it('refreshAllSources hands held renames to the caller', async () => {
    const { graph, ctx, fileId } = setup();
    await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    graph.drive.put(
      'Decks/vocab.csv',
      enc.encode('word,definition,topic\n나모,tree,nature\n강,river,nature\n'),
      1_700_000_300_000,
    );
    const summary = await refreshAllSources(ctx);
    expect(summary.pendingReconciliations).toHaveLength(1);
    expect(summary.importedNotes).toBe(0);
  });

  it('keeps an unlinked file unlinked, and relinking brings it back', async () => {
    const { ctx, state, fileId } = setup();
    await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    // What the Sources panel's Unlink does.
    const registry = await loadSourcesRegistry(ctx.platform, state);
    registry.oneDriveSources = [];
    registry.unlinkedOneDriveIds = [fileId()];
    await saveSourcesRegistry(ctx.platform, registry);

    const reloaded = await loadSourcesRegistry(ctx.platform, state);
    expect(reloaded.oneDriveSources).toEqual([]);
    expect(reloaded.unlinkedOneDriveIds).toEqual([fileId()]);

    await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, { columnMap: COLUMN_MAP });
    const again = await loadSourcesRegistry(ctx.platform, state);
    expect(again.oneDriveSources).toHaveLength(1);
    expect(again.unlinkedOneDriveIds ?? []).toEqual([]);
  });

  it('linking again with a new mapping updates the deck source and the notes', async () => {
    const { ctx, state, emitted, fileId } = setup();
    await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    const ignoreTopic = [
      { header: 'word', target: 'field:word' },
      { header: 'definition', target: 'field:meaning' },
      { header: 'topic', target: 'ignore' },
    ];
    emitted.length = 0;
    const res = await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      columnMap: ignoreTopic,
    });
    expect(res.registry.oneDriveSources).toHaveLength(1);
    const relinked = emitted.find((e) => e.type === 'SourceLinked');
    if (relinked?.type !== 'SourceLinked') throw new Error('no SourceLinked');
    expect(relinked.payload.source.column_map).toEqual(ignoreTopic);
    const deckId = res.source.deckId ?? '';
    expect(state.decks.get(deckId)?.source?.column_map).toEqual(ignoreTopic);
  });

  it("prefers the deck's synced column map over the one saved on the source", async () => {
    const { ctx, state, fileId } = setup();
    const { source } = await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    // This device's copy says "ignore topic", but the deck (synced) says topic -> tags.
    source.columnMap = [
      { header: 'word', target: 'field:word' },
      { header: 'definition', target: 'field:meaning' },
      { header: 'topic', target: 'ignore' },
    ];
    await refreshSingleOneDriveSource(source, ctx, { force: true });
    const deckId = source.deckId ?? '';
    expect(state.decks.get(deckId)?.source?.column_map).toEqual(COLUMN_MAP);
    expect([...state.notes.values()].every((n) => n.tags.includes('nature'))).toBe(true);
  });

  it('does not re-emit SourceLinked when nothing about the source changed', async () => {
    const { ctx, emitted, fileId } = setup();
    const { source } = await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    emitted.length = 0;
    await refreshSingleOneDriveSource(source, ctx, { force: true });
    expect(emitted).toEqual([]);
  });

  it('refuses to link into an archived deck and says how to fix it', async () => {
    const { ctx, state, fileId } = setup();
    const { source } = await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    const deck = state.decks.get(source.deckId ?? '');
    if (!deck) throw new Error('missing deck');
    deck.archived = true;
    await expect(linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx)).rejects.toThrow(
      /archived.*Restore it/,
    );
    // A background refresh leaves it alone without an error.
    const res = await refreshSingleOneDriveSource(source, ctx, { force: true });
    expect(res.updated).toBe(false);
    expect(source.lastError).toMatch(/archived/);
  });

  it('reports a file that was deleted from OneDrive, and a build without OneDrive', async () => {
    const { graph, ctx, fileId } = setup();
    const id = fileId();
    const { source } = await linkOneDriveFile({ id, name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    graph.drive.files.delete('Decks/vocab.csv');
    const failure = await refreshSingleOneDriveSource(source, ctx).catch((e: unknown) => e);
    expect(String(failure)).toMatch(/OneDrive file lookup failed/);
    expect(String(failure)).not.toContain(id);
    // refreshAllSources records the error on the row instead of throwing.
    const summary = await refreshAllSources(ctx);
    expect(summary.errors[0]).toMatch(/vocab: .*lookup failed/);
    expect(summary.registry.oneDriveSources?.[0]?.lastStatus).toBe('error');

    const noOneDrive = { ...ctx, platform: { ...ctx.platform, getOneDrivePicker: undefined } };
    await expect(refreshSingleOneDriveSource(source, noOneDrive as never)).rejects.toThrow(
      /not available/,
    );
  });

  it('skips linked OneDrive files entirely when OneDrive is not configured', async () => {
    const { ctx, fileId } = setup();
    await linkOneDriveFile({ id: fileId(), name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    const unconfigured = { ...ctx, platform: { ...ctx.platform, oneDriveConfigured: false } };
    const summary = await refreshAllSources(unconfigured as never);
    expect(summary.errors).toEqual([]);
    expect(summary.registry.oneDriveSources?.[0]?.lastStatus).toBe('synced');
  });
});

describe('readOneDriveTable', () => {
  const picked = (name: string, text: string) => ({ name, bytes: enc.encode(text) });

  it('reads .tsv with tab delimiters', async () => {
    const { ctx } = setup();
    const grid = await readOneDriveTable(
      ctx.platform,
      picked('v.tsv', 'word\tmeaning\n달\tmoon\n'),
    );
    expect(grid).toEqual([
      ['word', 'meaning'],
      ['달', 'moon'],
    ]);
  });

  it('reads .xlsx through the spreadsheet adapter', async () => {
    const { ctx } = setup();
    const grid = await readOneDriveTable(ctx.platform, picked('v.xlsx', 'unused'));
    expect(grid[1]).toEqual(['달', 'moon']);
  });

  it('explains when this device cannot read Excel files', async () => {
    const { ctx } = setup();
    const platform = {
      ...ctx.platform,
      getLocalFolderSources: async () => {
        throw new Error('Local folder sources are desktop/PC-only.');
      },
    } as unknown as PlatformServices;
    await expect(readOneDriveTable(platform, picked('v.xlsx', 'x'))).rejects.toThrow(
      /save .* as CSV/i,
    );
  });

  it('rejects an empty header row and other file types', async () => {
    const { ctx } = setup();
    await expect(readOneDriveTable(ctx.platform, picked('v.csv', ''))).rejects.toThrow(
      /no column names/,
    );
    await expect(readOneDriveTable(ctx.platform, picked('v.docx', 'x'))).rejects.toThrow(
      /not a \.csv/,
    );
  });
});
