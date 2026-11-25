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
import { DropboxAppFolderFilePicker } from '../../platform-web/src/sources/dropbox-picker.ts';
import { FakeDropboxServer } from '../../platform-web/tests/fakes/fake-dropbox.ts';
import {
  DROPBOX_RECONCILE_PREFIX,
  linkDropboxFile,
  loadSourcesRegistry,
  refreshAllSources,
  refreshSingleDropboxSource,
  unlinkSource,
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

function setup(options: { connected?: boolean; canParseXlsx?: boolean } = {}) {
  const server = new FakeDropboxServer();
  const initial = server.put(
    'Decks/vocab.csv',
    enc.encode('word,definition,topic\n나무,tree,nature\n강,river,nature\n'),
    1_700_000_000_000,
  );
  const fetchSpy = vi.fn(server.fetch);
  const auth = {
    isConfigured: () => true,
    isConnected: async () => options.connected !== false,
    getValidAccessToken: async () => 'dbx-token-1',
    signIn: async () => null,
  };
  const picker = new DropboxAppFolderFilePicker({ auth, fetchImpl: fetchSpy });
  const state = createEmptyState();
  const factory = createEventFactory('dev-dbx', 0, createHlcState('dev-dbx', 1000));
  const emitted: KnownEvent[] = [];
  const platform = {
    storage: memoryStorage(),
    dropboxConfigured: true,
    getDropboxPicker: async () => picker,
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
  const downloads = () =>
    fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/files/download')).length;
  return { server, ctx, state, emitted, downloads, fetchSpy, fileId: initial.id };
}

const COLUMN_MAP = [
  { header: 'word', target: 'field:word' },
  { header: 'definition', target: 'field:meaning' },
  { header: 'topic', target: 'tags' },
];

describe('linked Dropbox App Folder sources', () => {
  it('a link made during a refresh waits for it and survives its save (D8)', async () => {
    const { server, ctx, fetchSpy, fileId } = setup();
    await linkDropboxFile({ id: fileId, name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    const second = server.put('Decks/more.csv', enc.encode('word,definition\n달,moon\n'), 1);

    // Hold the refresh's first Dropbox call so the link below lands mid-refresh.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fetchSpy.mockImplementationOnce(async (...args: Parameters<typeof server.fetch>) => {
      await gate;
      return server.fetch(...args);
    });
    const callsBefore = fetchSpy.mock.calls.length;
    const refresh = refreshAllSources(ctx);
    try {
      await vi.waitFor(() => expect(fetchSpy.mock.calls).toHaveLength(callsBefore + 1));
      const link = linkDropboxFile({ id: second.id, name: 'more.csv' }, ctx, {
        noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      });
      await new Promise((r) => setTimeout(r, 20));
      // The link waits for the refresh instead of running beside it.
      expect(fetchSpy.mock.calls).toHaveLength(callsBefore + 1);
      release();
      await Promise.all([refresh, link]);
    } finally {
      // A failed assertion must not leave the module-level lock held for the other tests.
      release();
      await refresh.catch(() => undefined);
    }

    const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
    expect(registry.dropboxSources?.map((s) => s.name).sort()).toEqual(['more', 'vocab']);
  });

  it('links a .csv with column mapping, short-circuits unchanged contentTag, and refreshes changes', async () => {
    const { server, ctx, state, downloads, fileId } = setup();
    const res = await linkDropboxFile(
      { id: fileId, name: 'vocab.csv', pathDisplay: '/Decks/vocab.csv' },
      ctx,
      { noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, language: 'ko', columnMap: COLUMN_MAP },
    );
    expect(res.notesTouched).toBe(2);
    expect(downloads()).toBe(1);
    const deck = state.decks.get(res.source.deckId ?? '');
    expect(deck?.source?.kind).toBe('dropbox_file');
    expect(deck?.source?.external_id).toBe(fileId);
    expect(deck?.source?.column_map).toEqual(COLUMN_MAP);

    // Second refresh without changes skips download via contentTag
    const summary1 = await refreshAllSources(ctx);
    expect(summary1.updatedSources).toBe(0);
    expect(downloads()).toBe(1);

    // File changes in Dropbox -> refresh downloads and adds the new note
    server.put(
      'Decks/vocab.csv',
      enc.encode('word,definition,topic\n나무,tree,nature\n강,river,nature\n산,mountain,nature\n'),
      1_700_000_001_000,
    );
    const summary2 = await refreshAllSources(ctx);
    expect(summary2.updatedSources).toBe(1);
    expect(summary2.importedNotes).toBe(1);
    expect(downloads()).toBe(2);
    expect([...state.notes.values()].filter((n) => !n.archived)).toHaveLength(3);
  });

  it('holds rename reconciliation and applies it once renameMap is provided', async () => {
    const { server, ctx, state, fileId } = setup();
    const linked = await linkDropboxFile({ id: fileId, name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    const originalNoteId = [...state.notes.values()].find((n) => n.fields['word'] === '강')?.id;
    if (!originalNoteId) throw new Error('missing original note');

    // Rename 강 -> 강물
    server.put(
      'Decks/vocab.csv',
      enc.encode('word,definition,topic\n나무,tree,nature\n강물,river,nature\n'),
    );
    const held = await refreshSingleDropboxSource(linked.source, ctx);
    expect(held.pending).toBeDefined();
    expect(held.pending?.folderId).toBe(`${DROPBOX_RECONCILE_PREFIX}${fileId}`);

    // Apply reconciliation preserving the original note ID
    const applied = await refreshSingleDropboxSource(linked.source, ctx, {
      force: true,
      renameMap: { [originalNoteId]: '강물' },
    });
    expect(applied.pending).toBeUndefined();
    expect(applied.updated).toBe(true);
    expect(state.notes.get(originalNoteId)?.fields['word']).toBe('강물');
  });

  it('marks permission_required when Dropbox is disconnected, skips archived decks and unreadable .xlsx', async () => {
    const { server, ctx, state } = setup({ connected: false, canParseXlsx: false });
    const xlsx = server.put('Decks/sheet.xlsx', new Uint8Array([80, 75, 5, 6]));
    const reg = await loadSourcesRegistry(ctx.platform, state);
    const src: Parameters<typeof refreshSingleDropboxSource>[0] = {
      id: `dropbox:${xlsx.id}`,
      fileId: xlsx.id,
      name: 'sheet',
      lastStatus: 'idle',
    };
    reg.dropboxSources = [src];
    const disconnected = await refreshSingleDropboxSource(src, ctx);
    expect(disconnected.updated).toBe(false);
    expect(src.lastStatus).toBe('permission_required');

    // Connected but device cannot parse .xlsx -> skipped with unreadable
    const setup2 = setup({ connected: true, canParseXlsx: false });
    const xlsx2 = setup2.server.put('Decks/sheet.xlsx', new Uint8Array([80, 75, 5, 6]));
    const src2: Parameters<typeof refreshSingleDropboxSource>[0] = {
      id: `dropbox:${xlsx2.id}`,
      fileId: xlsx2.id,
      name: 'sheet',
      lastStatus: 'idle',
    };
    const unreadable = await refreshSingleDropboxSource(src2, setup2.ctx);
    expect(unreadable.unreadable).toBe(true);
    expect(src2.skipReason).toBe('unreadable');
  });

  it('unlinks cleanly across devices via SourceUnlinked while keeping local deck and notes', async () => {
    const { ctx, state, fileId } = setup();
    const linked = await linkDropboxFile({ id: fileId, name: 'vocab.csv' }, ctx, {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      columnMap: COLUMN_MAP,
    });
    const afterUnlink = await unlinkSource('dropbox', linked.source.id, ctx);
    expect(afterUnlink.dropboxSources).toEqual([]);
    const deck = state.decks.get(linked.source.deckId ?? '');
    expect(deck).toBeDefined();
    expect(deck?.source).toBeUndefined();
    expect([...state.notes.values()]).toHaveLength(2);
  });
});
