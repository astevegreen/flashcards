import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveNoteId,
  encodeUtf8,
  type KnownEvent,
} from '@flash/core';
import { exportFlashpkg } from '@flash/core/flashpkg';
import { FREE_TIER_MAX_DECKS, type EntitlementState } from '@flash/core/license';
import type {
  LinkedLocalFolder,
  LocalFolderSourcesAdapter,
  PackageSubscription,
  PlatformServices,
  ScannedLocalFileDescriptor,
} from '@flash/platform';
import { describe, expect, it } from 'vitest';
import {
  refreshSinglePackageSubscription,
  scanSingleLocalFolder,
} from '../src/sources/sourceRunner.ts';

const FREE: EntitlementState = {
  unlocked: false,
  source: 'free',
  personalBuild: false,
  productId: 'unlock_full',
};

/** A free-tier collection one deck below the limit. */
function nearLimit() {
  const state = createEmptyState();
  const factory = createEventFactory('dev-pc', 0, createHlcState('dev-pc', 1000));
  applyEvents(
    state,
    Array.from({ length: FREE_TIER_MAX_DECKS - 1 }, (_, i) =>
      factory.create(
        'DeckCreated',
        {
          deck_id: `own-${i}`,
          name: `Own ${i}`,
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
        },
        1000,
      ),
    ),
  );
  return { state, factory };
}

function packageBytes(deckId: string): Uint8Array {
  const pkgState = createEmptyState();
  const f = createEventFactory('cli', 0, createHlcState('cli', 500));
  applyEvents(pkgState, [
    f.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: deckId,
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      },
      500,
    ),
    f.create(
      'NoteUpserted',
      {
        note_id: deriveNoteId(deckId, 'k1'),
        deck_id: deckId,
        source_key: 'k1',
        fields: { word: '학교', meaning: 'school' },
      },
      500,
    ),
  ]);
  return exportFlashpkg(pkgState, { packageId: `pkg:${deckId}`, name: deckId, version: '1.0.0' });
}

describe('free-tier deck limit after linking (C14)', () => {
  it('a folder scan adds new decks only up to the limit and leaves the rest for later', async () => {
    const { state, factory } = nearLimit();
    const inbox = packageBytes('inbox-deck');
    const written: string[] = [];
    const moved: string[] = [];
    const csv = (name: string): ScannedLocalFileDescriptor => ({
      relativePath: name,
      name,
      kind: 'csv',
      isInbox: false,
      size: 30,
      lastModified: 1000,
    });
    const adapter = {
      ensurePermission: async () => true,
      listFolderFiles: async (): Promise<ScannedLocalFileDescriptor[]> => [
        csv('a.csv'),
        csv('b.csv'),
        {
          relativePath: 'Inbox/new.flashpkg',
          name: 'new.flashpkg',
          kind: 'flashpkg',
          isInbox: true,
          size: inbox.byteLength,
          lastModified: 1000,
        },
      ],
      readFileBytes: async (_id: string, rel: string) =>
        rel.endsWith('.flashpkg') ? inbox : encodeUtf8('Word,Meaning\n사과,apple\n'),
      readRelativeMedia: async () => null,
      writeFileText: async (_id: string, rel: string) => {
        written.push(rel);
      },
      moveInboxFileToImported: async (_id: string, name: string) => {
        moved.push(name);
        return true;
      },
    } as unknown as LocalFolderSourcesAdapter;
    const ctx = {
      platform: { getLocalFolderSources: async () => adapter } as unknown as PlatformServices,
      // Like the Sources panel, the state seen here doesn't change during the scan.
      getState: () => state,
      getEventFactory: () => factory,
      emitEvents: (events: readonly KnownEvent[]) => applyEvents(state, events),
      entitlement: FREE,
    };
    const folder: LinkedLocalFolder = {
      id: 'folder-1',
      name: 'Cards',
      addedAt: 1000,
      writeCardIds: true,
      files: {},
      inboxImported: {},
    };

    await scanSingleLocalFolder(folder, ctx);

    const active = [...state.decks.values()].filter((d) => !d.archived);
    expect(active).toHaveLength(FREE_TIER_MAX_DECKS);
    expect(active.map((d) => d.name)).toContain('a');
    expect(written).toEqual(['a.csv']);
    expect(moved).toEqual([]);
    expect(Object.keys(folder.files)).toEqual(['a.csv']);
    expect(folder.inboxImported).toEqual({});
    expect(folder.warnings?.filter((w) => w.code === 'deck_limit').map((w) => w.file)).toEqual([
      'b.csv',
      'Inbox/new.flashpkg',
    ]);

    // Unlocked: the next scan picks up what was left.
    await scanSingleLocalFolder(folder, { ...ctx, entitlement: { ...FREE, unlocked: true } });
    expect([...state.decks.values()].filter((d) => !d.archived)).toHaveLength(
      FREE_TIER_MAX_DECKS + 2,
    );
    expect(moved).toEqual(['new.flashpkg']);
  });

  it('a package refresh that would pass the limit fails without adding anything', async () => {
    const { state, factory } = nearLimit();
    applyEvents(state, [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'own-last',
          name: 'Own last',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
        },
        1000,
      ),
    ]);
    const before = state.decks.size;
    const bytes = packageBytes('pkg-deck');
    const ctx = {
      platform: {
        getPackageFetcher: async () => ({
          fetchPackage: async () => ({ bytes, notModified: false }),
        }),
      } as unknown as PlatformServices,
      getState: () => state,
      getEventFactory: () => factory,
      emitEvents: (events: readonly KnownEvent[]) => applyEvents(state, events),
      entitlement: FREE,
    };
    const sub: PackageSubscription = {
      id: 's1',
      url: 'https://example.com/p.flashpkg',
      title: 'P',
    };
    await expect(refreshSinglePackageSubscription(sub, ctx)).rejects.toThrow(/Free tier/);
    expect(state.decks.size).toBe(before);
  });
});
