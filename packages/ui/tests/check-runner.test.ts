import 'fake-indexeddb/auto';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type CollectionState,
  type KnownEvent,
} from '@flash/core';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '@flash/core/samples';
import type { PlatformServices } from '@flash/platform';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieStorage } from '../../platform-web/src/storage/dexie-storage.ts';
import {
  reAddUnlistedMedia,
  removeUnusedMedia,
  runDatabaseCheck,
  runMediaCheck,
  saveRebuiltCollection,
  type RemoveMediaContext,
} from '../src/check/checkRunner.ts';
import {
  COLLECTION_REBUILT_KV_KEY,
  rebuiltSince,
  snapshotWriteAllowed,
} from '../src/state/rebuildSignal.ts';
import {
  putMediaTracked,
  RECENT_MEDIA_MS,
  recentlyStoredMedia,
  resetRecentMediaForTests,
} from '../src/state/recentMedia.ts';

const opened: DexieStorage[] = [];
afterEach(() => {
  resetRecentMediaForTests();
  for (const storage of opened.splice(0)) storage.close();
});

const USED = 'a'.repeat(64);
const UNUSED = 'b'.repeat(64);
const ORPHAN = 'c'.repeat(64);

async function setup() {
  const storage = new DexieStorage(`check-runner-${Date.now()}-${Math.random()}`);
  opened.push(storage);
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 0));
  const events: KnownEvent[] = buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS);
  const deckId = events.find((e) => e.type === 'DeckCreated')?.payload;
  if (!deckId || !('deck_id' in deckId)) throw new Error('no sample deck');
  const at = SAMPLE_SEED_EPOCH_MS + 1000;
  for (const hash of [USED, UNUSED]) {
    events.push(
      factory.create('MediaAdded', { media: { hash, ext: 'png', mime: 'image/png', size: 3 } }, at),
    );
  }
  events.push(
    factory.create(
      'NoteUpserted',
      {
        note_id: 'n-media',
        deck_id: deckId.deck_id,
        source_key: 'n-media',
        fields: { front: `<img src="media:${USED}">` },
      },
      at,
    ),
  );
  await storage.appendEvents(events);
  for (const hash of [USED, UNUSED, ORPHAN]) {
    await storage.putMedia({ hash, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
  }
  const state: { current: CollectionState } = {
    current: applyEvents(createEmptyState(), events),
  };
  const platform = { deviceId: 'dev-a', storage } as unknown as PlatformServices;
  const ctx: RemoveMediaContext = {
    platform,
    getState: () => state.current,
    emitEvents: (evs: readonly KnownEvent[]) => {
      applyEvents(state.current, evs);
      void storage.appendEvents(evs);
    },
    getEventFactory: () => factory,
  };
  return { storage, state, ctx };
}

describe('check media on a device', () => {
  it('removes unused files from the collection and the device after a check', async () => {
    const { storage, state, ctx } = await setup();
    const { report } = await runMediaCheck(ctx);
    expect(report.unused.map((u) => u.hash)).toEqual([UNUSED, ORPHAN]);
    expect(report.missing).toEqual([]);

    const result = await removeUnusedMedia(ctx);
    expect(result).toEqual({ removedFromCollection: 1, filesDeleted: 2, filesKeptForBackups: 0 });
    expect(state.current.media.has(UNUSED)).toBe(false);
    expect((await storage.listMediaHashes()).sort()).toEqual([USED]);
    expect((await runMediaCheck(ctx)).report.unused).toEqual([]);
  });

  it('keeps a file an import has just stored but not yet added to the collection (D16)', async () => {
    const { storage, state, ctx } = await setup();
    const IMPORTING = 'd'.repeat(64);
    // An import stores its files first; the MediaAdded events and the notes come later.
    await putMediaTracked(storage, {
      hash: IMPORTING,
      mime: 'image/png',
      bytes: new Uint8Array([4]),
    });
    expect((await runMediaCheck(ctx)).report.unused.map((u) => u.hash)).toContain(IMPORTING);

    const result = await removeUnusedMedia(ctx);
    expect(result).toEqual({ removedFromCollection: 1, filesDeleted: 2, filesKeptForBackups: 0 });
    expect((await storage.listMediaHashes()).sort()).toEqual([USED, IMPORTING]);
    expect(state.current.media.has(UNUSED)).toBe(false);
  });

  it('forgets a stored file once the recent window has passed', async () => {
    const { storage } = await setup();
    const at = Date.now();
    await putMediaTracked(storage, {
      hash: 'E'.repeat(64),
      mime: 'image/png',
      bytes: new Uint8Array([5]),
    });
    expect(recentlyStoredMedia(at + 1000).has('e'.repeat(64))).toBe(true);
    expect(recentlyStoredMedia(at + RECENT_MEDIA_MS + 1000).size).toBe(0);
  });

  it('adds back a used file the collection no longer lists, so sync shares it again', async () => {
    const { state, ctx } = await setup();
    // A removal from another device won over the note that uses USED.
    ctx.emitEvents([ctx.getEventFactory().create('MediaRemoved', { hash: USED }, Date.now())]);
    expect(state.current.media.has(USED)).toBe(false);
    const { report } = await runMediaCheck(ctx);
    expect(report.unlisted.map((f) => f.hash)).toEqual([USED]);
    expect(report.unlisted[0]?.noteIds).toEqual(['n-media']);

    expect(await reAddUnlistedMedia(ctx)).toBe(1);
    expect(state.current.media.get(USED)).toMatchObject({ ext: 'png', mime: 'image/png', size: 3 });
    expect((await runMediaCheck(ctx)).report.unlisted).toEqual([]);
  });
});

describe('check database on a device', () => {
  it('finds no differences, then the drift of a damaged collection, and rebuilds it', async () => {
    const { storage, state, ctx } = await setup();
    const clean = await runDatabaseCheck(ctx);
    expect(clean.mode).toBe('full');
    expect(clean.comparison.total).toBe(0);
    expect(clean.changedDuringCheck).toBe(false);

    const card = [...state.current.cards.values()][0];
    if (!card) throw new Error('no cards');
    state.current.cards.delete(card.id);
    const drifted = await runDatabaseCheck(ctx);
    expect(drifted.comparison.differences).toContainEqual({
      area: 'cards',
      id: card.id,
      kind: 'missing',
    });
    if (!drifted.rebuilt) throw new Error('expected a full rebuild');

    // The rebuild reads the log and its local seq together.
    expect(drifted.rebuilt.localSeq).toBe(await storage.getMaxLocalSeq());
    const before = Date.now();
    await saveRebuiltCollection({ ...ctx, deviceId: 'dev-a' }, drifted.rebuilt);
    // Tabs started before the rebuild stop writing snapshots over it.
    expect(rebuiltSince(await storage.getKv(COLLECTION_REBUILT_KV_KEY), before)).toBe(true);
    expect(rebuiltSince(await storage.getKv(COLLECTION_REBUILT_KV_KEY), Date.now() + 1)).toBe(
      false,
    );
    // Every snapshot write (edits and syncs) asks this first.
    expect(await snapshotWriteAllowed(storage, before)).toBe(false);
    expect(await snapshotWriteAllowed(storage, Date.now() + 1)).toBe(true);
    expect(await snapshotWriteAllowed(storage, undefined)).toBe(true);
    const saved = await storage.getLocalSnapshot();
    expect(saved?.snapshot.cards.some((c) => c.id === card.id)).toBe(true);
    expect((await storage.loadMaterializedCards()).some((c) => c.id === card.id)).toBe(true);
  });

  it('reports a rebuild another tab saved over', async () => {
    const { storage, ctx } = await setup();
    const result = await runDatabaseCheck(ctx);
    if (!result.rebuilt) throw new Error('expected a full rebuild');
    const realSet = storage.setLocalSnapshot.bind(storage);
    // Another tab writes its own snapshot right after this one.
    storage.setLocalSnapshot = async (record) => {
      await realSet(record);
      await realSet({ ...record, localSeq: record.localSeq - 1, savedAt: record.savedAt + 1 });
    };
    await expect(
      saveRebuiltCollection({ ...ctx, deviceId: 'dev-a' }, result.rebuilt),
    ).rejects.toThrow(/Another tab/);
  });
});
