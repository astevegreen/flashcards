import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveNoteId,
  type CollectionState,
  type KnownEvent,
} from '@flash/core';
import { exportFlashpkg } from '@flash/core/flashpkg';
import type {
  LinkedLocalFolder,
  LocalFolderSourcesAdapter,
  PackageSubscription,
  PlatformServices,
  ScannedLocalFileDescriptor,
} from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import {
  refreshSinglePackageSubscription,
  scanSingleLocalFolder,
  type ArchivePreviewRequest,
} from '../src/sources/sourceRunner.ts';

const DECK = 'pkg-deck';

/** One package deck at a version, holding a note per key. */
function packageBytes(keys: readonly string[], version: string): Uint8Array {
  const pkgState = createEmptyState();
  const f = createEventFactory('cli', 0, createHlcState('cli', 500));
  applyEvents(pkgState, [
    f.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: 'Words',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      },
      500,
    ),
    ...keys.map((k) =>
      f.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(DECK, k),
          deck_id: DECK,
          source_key: k,
          fields: { word: k, meaning: k },
        },
        500,
      ),
    ),
  ]);
  return exportFlashpkg(pkgState, { packageId: 'pkg:words', name: 'Words', version });
}

const V1 = packageBytes(['k1', 'k2', 'k3'], '1.0.0');
/** k2 and k3 were replaced by k4: an update that archives 2 notes. */
const V2 = packageBytes(['k1', 'k4'], '2.0.0');

function activeWords(state: CollectionState): string[] {
  return [...state.notes.values()]
    .filter((n) => !n.archived)
    .map((n) => n.fields['word'] ?? '')
    .sort();
}

/** A collection subscribed to the package at v1, and a refresh context serving `next`. */
function subscribedAtV1(confirmArchive?: (r: ArchivePreviewRequest) => Promise<boolean>) {
  const state = createEmptyState();
  const factory = createEventFactory('dev-pc', 0, createHlcState('dev-pc', 1000));
  const emitted: KnownEvent[][] = [];
  let served = V1;
  const ctx = {
    platform: {
      getPackageFetcher: async () => ({
        fetchPackage: async () => ({ bytes: served, notModified: false }),
      }),
      storage: { putMedia: async () => {} },
    } as unknown as PlatformServices,
    getState: () => state,
    getEventFactory: () => factory,
    emitEvents: (events: readonly KnownEvent[]) => {
      emitted.push([...events]);
      applyEvents(state, events);
    },
    ...(confirmArchive ? { confirmArchive } : {}),
  };
  const sub: PackageSubscription = { id: 's1', url: 'https://example.com/w.flashpkg', title: 'W' };
  return {
    state,
    ctx,
    sub,
    emitted,
    serve: (bytes: Uint8Array) => {
      served = bytes;
    },
  };
}

describe('package update that archives notes (C9 preview)', () => {
  it('Cancel writes nothing and leaves the subscription at its old version', async () => {
    const confirm = vi.fn(async () => false);
    const s = subscribedAtV1(confirm);
    await refreshSinglePackageSubscription(s.sub, s.ctx, { force: true });
    expect(confirm).not.toHaveBeenCalled(); // the first import archives nothing
    const before = activeWords(s.state);
    const writes = s.emitted.length;

    s.serve(V2);
    await expect(refreshSinglePackageSubscription(s.sub, s.ctx, { force: true })).rejects.toThrow(
      /cancelled .* would archive 2 notes/,
    );
    expect(confirm).toHaveBeenCalledWith({ sourceName: 'Words', notesArchived: 2 });
    expect(s.emitted).toHaveLength(writes);
    expect(activeWords(s.state)).toEqual(before);
    expect(s.sub.version).toBe('1.0.0');
  });

  it('Continue archives exactly the notes the preview counted', async () => {
    const confirm = vi.fn(async () => true);
    const s = subscribedAtV1(confirm);
    await refreshSinglePackageSubscription(s.sub, s.ctx, { force: true });
    const activeBefore = activeWords(s.state).length;

    s.serve(V2);
    await refreshSinglePackageSubscription(s.sub, s.ctx, { force: true });
    expect(confirm).toHaveBeenCalledOnce();
    const archived = s.emitted.at(-1)?.filter((e) => e.type === 'NoteArchived') ?? [];
    expect(archived).toHaveLength(2);
    expect(activeWords(s.state)).toEqual(['k1', 'k4']);
    expect(activeWords(s.state).length).toBe(activeBefore - 2 + 1);
    expect(s.sub.version).toBe('2.0.0');
  });

  it('does not ask when the update archives nothing', async () => {
    const confirm = vi.fn(async () => false);
    const s = subscribedAtV1(confirm);
    await refreshSinglePackageSubscription(s.sub, s.ctx, { force: true });
    s.serve(packageBytes(['k1', 'k2', 'k3', 'k5'], '1.1.0'));
    await refreshSinglePackageSubscription(s.sub, s.ctx, { force: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(activeWords(s.state)).toEqual(['k1', 'k2', 'k3', 'k5']);
  });

  it('holds the update in a background run that cannot ask', async () => {
    const s = subscribedAtV1();
    await refreshSinglePackageSubscription(s.sub, s.ctx, { force: true });
    const writes = s.emitted.length;
    s.serve(V2);
    await expect(refreshSinglePackageSubscription(s.sub, s.ctx, { force: true })).rejects.toThrow(
      /Not updated: .* would archive 2 notes/,
    );
    expect(s.emitted).toHaveLength(writes);
  });

  it('a folder package that would archive notes is held with a warning and not cached', async () => {
    const state = createEmptyState();
    const factory = createEventFactory('dev-pc', 0, createHlcState('dev-pc', 1000));
    let bytes = V1;
    const file = (): ScannedLocalFileDescriptor => ({
      relativePath: 'words.flashpkg',
      name: 'words.flashpkg',
      kind: 'flashpkg',
      isInbox: false,
      size: bytes.byteLength,
      lastModified: bytes === V1 ? 1000 : 2000,
    });
    const adapter = {
      ensurePermission: async () => true,
      listFolderFiles: async () => [file()],
      readFileBytes: async () => bytes,
    } as unknown as LocalFolderSourcesAdapter;
    const confirm = vi.fn(async () => false);
    const ctx = {
      platform: {
        getLocalFolderSources: async () => adapter,
        storage: { putMedia: async () => {} },
      } as unknown as PlatformServices,
      getState: () => state,
      getEventFactory: () => factory,
      emitEvents: (events: readonly KnownEvent[]) => applyEvents(state, events),
      confirmArchive: confirm,
    };
    const folder: LinkedLocalFolder = {
      id: 'folder-1',
      name: 'Cards',
      addedAt: 1000,
      writeCardIds: false,
      files: {},
      inboxImported: {},
    };
    await scanSingleLocalFolder(folder, ctx);
    const cachedV1 = folder.files['words.flashpkg']?.contentHash;
    expect(cachedV1).toBeDefined();

    bytes = V2;
    await scanSingleLocalFolder(folder, ctx);
    expect(confirm).toHaveBeenCalledWith({ sourceName: 'words.flashpkg', notesArchived: 2 });
    expect(activeWords(state)).toEqual(['k1', 'k2', 'k3']);
    expect(folder.files['words.flashpkg']?.contentHash).toBe(cachedV1);
    expect(folder.warnings?.map((w) => w.code)).toContain('archive_held');
  });
});
