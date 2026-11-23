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
  refreshSingleOneDriveSource,
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
    getOneDrivePicker: async () => picker,
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

    // One row edited, one removed, one added.
    graph.drive.put(
      'Decks/vocab.csv',
      enc.encode('word,definition,topic\n나무,big tree,nature\n산,mountain,nature\n'),
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
    expect(byWord.get('강')?.archived).toBe(true);
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
