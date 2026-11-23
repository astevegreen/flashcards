import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type KnownEvent,
  type SourceRef,
} from '@flash/core';
import type { PlatformServices, Storage } from '@flash/platform';
import { describe, expect, it } from 'vitest';
import {
  loadSourcesRegistry,
  refreshAllSources,
  refreshSingleGoogleSource,
  saveSourcesRegistry,
  unlinkSource,
} from '../src/sources/sourceRunner.ts';

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

/** A device whose collection has one deck per given source, and one Google Doc page. */
function setup(sources: Record<string, SourceRef>, withDoc = true) {
  const state = createEmptyState();
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 1000));
  const emitted: KnownEvent[] = [];
  const ctx = {
    platform: {
      storage: memoryStorage(),
      getGoogleAuth: async () => ({ isConnected: async () => true }),
      getGoogleSourcesClient: async () => {
        throw new Error('Google should not be called');
      },
    } as unknown as PlatformServices,
    getState: () => state,
    getEventFactory: () => factory,
    emitEvents: (events: readonly KnownEvent[]) => {
      emitted.push(...events);
      applyEvents(state, events);
    },
  };
  const seed: KnownEvent[] = Object.entries(sources).map(([deckId, source]) =>
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: `Deck ${deckId}`,
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        source,
        created_at: 1000,
      },
      1000,
    ),
  );
  if (withDoc)
    seed.push(
      factory.create(
        'PageUpserted',
        {
          page_id: 'page-doc',
          slug: 'grammar',
          title: 'Grammar',
          markdown: '# Grammar',
          source: { kind: 'google_docs', external_id: 'doc-1' },
        },
        1000,
      ),
    );
  ctx.emitEvents(seed);
  emitted.length = 0;
  return { ctx, state, emitted };
}

describe('Unlink syncs through SourceUnlinked', () => {
  it('a Google Sheet stays unlinked (it used to come back from the deck at once)', async () => {
    const { ctx, state, emitted } = setup({
      'deck-sheet': { kind: 'google_sheets', external_id: 'sheet-1' },
      'deck-other': { kind: 'google_sheets', external_id: 'sheet-2' },
    });
    const listed = await loadSourcesRegistry(ctx.platform, state);
    await saveSourcesRegistry(ctx.platform, listed);
    expect(listed.googleSources.map((s) => s.fileId).toSorted()).toEqual([
      'doc-1',
      'sheet-1',
      'sheet-2',
    ]);

    const after = await unlinkSource('google', 'gsheet:sheet-1', ctx);
    expect(emitted.map((e) => [e.type, e.payload])).toEqual([
      ['SourceUnlinked', { target_kind: 'deck', target_id: 'deck-sheet' }],
    ]);
    expect(state.decks.get('deck-sheet')?.source).toBeUndefined();
    expect(state.decks.get('deck-other')?.source?.external_id).toBe('sheet-2');
    for (const reg of [after, await loadSourcesRegistry(ctx.platform, state)]) {
      expect(reg.googleSources.map((s) => s.fileId).toSorted()).toEqual(['doc-1', 'sheet-2']);
    }
  });

  it('a Google Doc unlinks its page, and another device drops its saved row', async () => {
    const a = setup({});
    const b = setup({});
    // Device B has the Doc saved in its own registry.
    await saveSourcesRegistry(b.ctx.platform, await loadSourcesRegistry(b.ctx.platform, b.state));

    await unlinkSource('google', 'gdoc:doc-1', a.ctx);
    expect(a.emitted.map((e) => e.type)).toEqual(['SourceUnlinked']);
    applyEvents(b.state, a.emitted);
    expect(b.state.pages.get('page-doc')?.source).toBeUndefined();
    expect((await loadSourcesRegistry(b.ctx.platform, b.state)).googleSources).toEqual([]);
  });

  it('a .flashpkg URL subscription stays unlinked', async () => {
    const url = 'https://example.com/deck.flashpkg';
    const { ctx, state } = setup({ 'deck-pkg': { kind: 'package_url', uri: url } });
    const listed = await loadSourcesRegistry(ctx.platform, state);
    const sub = listed.packageSubscriptions[0];
    if (!sub) throw new Error('no subscription');
    await unlinkSource('package', sub.id, ctx);
    expect(state.decks.get('deck-pkg')?.source).toBeUndefined();
    expect((await loadSourcesRegistry(ctx.platform, state)).packageSubscriptions).toEqual([]);
  });

  it('a catalog unlink stays on this device and emits nothing', async () => {
    const { ctx, emitted } = setup({});
    const reg = await loadSourcesRegistry(ctx.platform);
    reg.catalogs = [
      { id: 'cat-1', url: 'https://example.com/index.json', name: 'Family', packages: [] },
    ];
    await saveSourcesRegistry(ctx.platform, reg);
    const after = await unlinkSource('catalog', 'cat-1', ctx);
    expect(after.catalogs).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

describe('Google Sheet on an archived deck', () => {
  it('is not refreshed, and says why instead of "up to date"', async () => {
    const { ctx, state, emitted } = setup(
      { 'deck-sheet': { kind: 'google_sheets', external_id: 'sheet-1' } },
      false,
    );
    const deck = state.decks.get('deck-sheet');
    if (!deck) throw new Error('missing deck');
    deck.archived = true;
    const registry = await loadSourcesRegistry(ctx.platform);
    registry.googleSources = [
      {
        id: 'gsheet:sheet-1',
        kind: 'google_sheets',
        fileId: 'sheet-1',
        name: 'Deck deck-sheet',
        uri: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        deckId: 'deck-sheet',
        lastStatus: 'synced',
      },
    ];
    await saveSourcesRegistry(ctx.platform, registry);

    const source = registry.googleSources[0];
    if (!source) throw new Error('missing source');
    const res = await refreshSingleGoogleSource(source, ctx, { force: true });
    expect(res.updated).toBe(false);
    expect(source).toMatchObject({ lastStatus: 'idle', skipReason: 'archived' });
    expect(source.lastError).toMatch(/archived.*Restore it/);
    expect(emitted).toEqual([]);

    const summary = await refreshAllSources(ctx);
    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toEqual([expect.stringMatching(/^Deck deck-sheet: .*archived/)]);
  });
});
