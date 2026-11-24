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
import type { DeviceMeta, PlatformServices, SyncProviderKind } from '@flash/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DexieStorage } from '../../platform-web/src/storage/dexie-storage.ts';
import { InMemorySyncTransport } from '../../platform-web/src/sync/in-memory-transport.ts';
import {
  applyRestore,
  BACKUP_STATUS_KV_KEY,
  BackupNotSavedError,
  listSyncFolderBackups,
  loadBackupStatus,
  openBackupStore,
  prepareRestore,
  readSyncFolderBackup,
  runAutoBackupIfDue,
  saveBackupSettings,
  takeBackup,
  type RestoreContext,
} from '../src/backups/backupRunner.ts';

// fake-indexeddb keeps every database in memory for this file only.
const opened: DexieStorage[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const storage of opened.splice(0)) storage.close();
});

const DAY = 24 * 60 * 60 * 1000;

function setup(provider: SyncProviderKind = 'none') {
  const storage = new DexieStorage(`backup-runner-${Date.now()}-${Math.random()}`);
  opened.push(storage);
  const transport = new InMemorySyncTransport();
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 0));
  const state: { current: CollectionState } = {
    current: applyEvents(createEmptyState(), buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS)),
  };
  const meta: DeviceMeta = { deviceId: 'dev-a', seq: 0, hlc: createHlcState('dev-a', 0) };
  const platform = {
    deviceId: 'dev-a',
    storage,
    syncTransport: transport,
  } as unknown as PlatformServices;
  const ctx: RestoreContext = {
    platform,
    getState: () => state.current,
    getMeta: () => meta,
    getSyncProvider: () => provider,
    emitEvents: (events: readonly KnownEvent[]) => {
      applyEvents(state.current, events);
    },
    getEventFactory: () => factory,
  };
  return { storage, transport, factory, state, ctx };
}

describe('rolling backups on a device', () => {
  // 21 snapshots: about 2 s alone, past the 5 s default when the whole suite runs at once.
  it('takes one automatic snapshot a day, only after a change, and prunes to 14', async () => {
    const { storage, ctx, factory, state } = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.UTC(2026, 10, 1, 9);
    vi.setSystemTime(now);

    expect(await runAutoBackupIfDue(ctx)).not.toBeNull();
    expect(await runAutoBackupIfDue(ctx)).toBeNull(); // same day
    now += DAY;
    vi.setSystemTime(now);
    expect(await runAutoBackupIfDue(ctx)).toBeNull(); // nothing changed

    const deck = [...state.current.decks.values()][0];
    for (let day = 0; day < 20; day++) {
      if (deck) {
        ctx.emitEvents([
          factory.create('DeckSettingsChanged', { deck_id: deck.id, name: `Deck ${day}` }, now),
        ]);
      }
      expect(await runAutoBackupIfDue(ctx)).not.toBeNull();
      now += DAY;
      vi.setSystemTime(now);
    }
    const kept = await (await storage.openBackupStore()).list();
    expect(kept).toHaveLength(14);
    // Sample decks carry no media, so every snapshot is a daily one.
    expect(kept.every((b) => b.kind === 'daily' && b.reason === 'auto')).toBe(true);
  }, 20_000);

  it('copies each snapshot to the sync folder when asked, one slot per weekday', async () => {
    const { storage, ctx } = setup('dev_channel');
    await saveBackupSettings(storage, { syncFolderCopy: true });
    const result = await takeBackup(ctx, 'manual');
    expect(result?.syncCopyWritten).toBe(true);
    const remote = await listSyncFolderBackups(ctx);
    expect(remote).toHaveLength(1);
    expect(remote[0]?.deviceId).toBe('dev-a');
    const bytes = await readSyncFolderBackup(ctx, remote[0]?.path ?? '');
    expect(prepareRestore(ctx, bytes).plan.steps).toHaveLength(0);
  });

  it('restores after a confirmed preview and keeps a pre-restore snapshot', async () => {
    const { storage, ctx, factory, state } = setup();
    const taken = await takeBackup(ctx, 'manual');
    const note = [...state.current.notes.values()][0];
    if (!taken || !note) throw new Error('setup failed');
    ctx.emitEvents([factory.create('NoteArchived', { note_id: note.id }, Date.now())]);

    const bytes = await (await storage.openBackupStore()).getBytes(taken.info.backup_id);
    const prepared = prepareRestore(ctx, bytes ?? new Uint8Array());
    expect(prepared.plan.summary.notesRestored).toBe(1);

    const result = await applyRestore(ctx, prepared.read);
    expect(result.eventCount).toBe(1);
    expect(result.preRestoreBackup?.reason).toBe('pre-restore');
    expect(state.current.notes.get(note.id)?.archived).toBe(false);
    expect((await (await storage.openBackupStore()).list()).map((b) => b.reason)).toEqual([
      'pre-restore',
      'manual',
    ]);
  });

  it('keeps pre-restore snapshots outside the rolling 14 and never prunes the one restored', async () => {
    const { storage, ctx } = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.UTC(2026, 10, 1, 9);
    for (let i = 0; i < 14; i++) {
      vi.setSystemTime(now);
      await takeBackup(ctx, 'manual');
      now += DAY;
    }
    const store = await storage.openBackupStore();
    const oldest = (await store.list()).at(-1);
    if (!oldest) throw new Error('setup failed');
    const bytes = await store.getBytes(oldest.backup_id);
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(now + i * 1000);
      await applyRestore(ctx, prepareRestore(ctx, bytes ?? new Uint8Array()).read);
    }
    const kept = await store.list();
    expect(kept.filter((b) => b.reason === 'manual')).toHaveLength(14);
    expect(kept.filter((b) => b.reason === 'pre-restore')).toHaveLength(3);
    expect(kept.some((b) => b.backup_id === oldest.backup_id)).toBe(true);
  });

  it('skips a snapshot on low storage, records why, and leaves the collection alone', async () => {
    const { storage, ctx, state } = setup();
    vi.stubGlobal('navigator', {
      storage: { estimate: () => Promise.resolve({ quota: 10_000_000, usage: 9_000_000 }) },
    });
    const notesBefore = state.current.notes.size;
    await expect(takeBackup(ctx, 'manual')).rejects.toBeInstanceOf(BackupNotSavedError);
    expect(await (await storage.openBackupStore()).list()).toHaveLength(0);
    expect((await loadBackupStatus(storage))?.lastError).toMatch(/Not enough free storage/);
    expect(state.current.notes.size).toBe(notesBefore);

    vi.unstubAllGlobals();
    expect(await takeBackup(ctx, 'manual')).not.toBeNull();
    expect((await loadBackupStatus(storage))?.lastError).toBeUndefined();
  });

  it('after a Reset, a daily backup restores with its media still on the device', async () => {
    const { storage, ctx, factory, state } = setup();
    const hash = 'c'.repeat(64);
    await storage.putMedia({ hash, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    ctx.emitEvents([
      factory.create(
        'MediaAdded',
        { media: { hash, ext: 'png', mime: 'image/png', size: 3 } },
        Date.now(),
      ),
    ]);
    const taken = await takeBackup(ctx, 'manual', { kind: 'daily' });
    expect(taken?.info.media_included).toBe(false);
    expect(taken?.info.media_hashes).toEqual([hash]);

    // Reset: the collection goes, the backups and the media they list stay.
    await storage.clearAll();
    state.current = createEmptyState();
    const bytes = await (await storage.openBackupStore()).getBytes(taken?.info.backup_id ?? '');
    const result = await applyRestore(ctx, prepareRestore(ctx, bytes ?? new Uint8Array()).read);
    expect(result.mediaMissing).toBe(0);
    expect((await storage.getMedia(hash))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(state.current.media.has(hash)).toBe(true);
  });

  it('prunes only after the new snapshot is stored', async () => {
    const { storage, ctx } = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.UTC(2026, 10, 1, 9);
    for (let i = 0; i < 14; i++) {
      vi.setSystemTime(now);
      await takeBackup(ctx, 'manual');
      now += DAY;
    }
    const store = await openBackupStore(storage);
    if (!store) throw new Error('no store');
    const before = (await store.list()).map((b) => b.backup_id);
    vi.setSystemTime(now);
    const realPut = store.put.bind(store);
    store.put = () => Promise.reject(new Error('QuotaExceededError'));
    await expect(takeBackup(ctx, 'manual')).rejects.toBeInstanceOf(BackupNotSavedError);
    expect((await store.list()).map((b) => b.backup_id)).toEqual(before);
    store.put = realPut;
    await takeBackup(ctx, 'manual');
    const after = (await store.list()).map((b) => b.backup_id);
    expect(after).toHaveLength(14);
    expect(after).not.toContain(before.at(-1));
  });

  it('on a store the storage estimate does not count, skips media snapshots after a failure', async () => {
    const { storage, ctx, factory } = setup();
    const real = await storage.openBackupStore();
    // What a native SQLite store looks like: no `measuredByStorageEstimate`.
    storage.openBackupStore = () => Promise.resolve({ ...real, measuredByStorageEstimate: false });
    const hash = 'd'.repeat(64);
    await storage.putMedia({ hash, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    ctx.emitEvents([
      factory.create(
        'MediaAdded',
        { media: { hash, ext: 'png', mime: 'image/png', size: 3 } },
        Date.now(),
      ),
    ]);
    // Even a nearly full browser quota doesn't count for such a store.
    vi.stubGlobal('navigator', {
      storage: { estimate: () => Promise.resolve({ quota: 10_000_000, usage: 9_999_000 }) },
    });
    await storage.setKv(BACKUP_STATUS_KV_KEY, { lastError: 'SQLITE_FULL', at: Date.now() });
    const afterFailure = await takeBackup(ctx, 'manual');
    expect(afterFailure?.info.kind).toBe('daily');
    // Once one succeeded, the weekly full snapshot with media comes back.
    const next = await takeBackup(ctx, 'manual');
    expect(next?.info.kind).toBe('full');
    expect(next?.info.media_included).toBe(true);
  });

  it('gives up on a snapshot that never finishes, so later ones still run', async () => {
    const { storage, ctx } = setup();
    const store = await openBackupStore(storage);
    if (!store) throw new Error('no store');
    await takeBackup(ctx, 'manual'); // warm up, so only the write can be slow
    const realPut = store.put.bind(store);
    store.put = () => new Promise<void>(() => undefined); // a write that never settles
    await expect(takeBackup(ctx, 'manual', { timeoutMs: 2000 })).rejects.toThrow(/too long/);
    store.put = realPut;
    expect(await takeBackup(ctx, 'manual')).not.toBeNull();
    expect(await runAutoBackupIfDue(ctx)).toBeNull(); // not blocked: nothing due right after
  });

  it('never stores, prunes or copies a snapshot that was stopped', async () => {
    const { storage, ctx } = setup();
    const store = await openBackupStore(storage);
    if (!store) throw new Error('no store');
    await takeBackup(ctx, 'manual'); // warm up, so only the write is slow
    const before = (await store.list()).map((b) => b.backup_id);
    const realPut = store.put.bind(store);
    let writeDone: Promise<void> | undefined;
    // A write that finishes only after the snapshot was given up on.
    store.put = (info, bytes) => {
      writeDone = new Promise<void>((resolve) => setTimeout(resolve, 300)).then(() =>
        realPut(info, bytes),
      );
      return writeDone;
    };
    await expect(takeBackup(ctx, 'manual', { timeoutMs: 100 })).rejects.toThrow(/too long/);
    await writeDone;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await store.list()).map((b) => b.backup_id)).toEqual(before);
  });

  it('does not count time the page is hidden, and starts no automatic snapshot while hidden', async () => {
    const { storage, ctx } = setup();
    const store = await openBackupStore(storage);
    if (!store) throw new Error('no store');
    const page = Object.assign(new EventTarget(), { hidden: true });
    vi.stubGlobal('document', page);
    expect(await runAutoBackupIfDue(ctx)).toBeNull();
    expect(await store.list()).toEqual([]);
    await takeBackup(ctx, 'manual'); // warm up
    const realPut = store.put.bind(store);
    store.put = (info, bytes) =>
      new Promise<void>((resolve) => setTimeout(resolve, 300)).then(() => realPut(info, bytes));
    // Hidden for the whole slow write: the 100 ms clock never runs out.
    const result = await takeBackup(ctx, 'manual', { timeoutMs: 100 });
    expect((await store.list()).map((b) => b.backup_id)).toContain(result?.info.backup_id);
    // Visible again: the clock runs.
    page.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    await expect(takeBackup(ctx, 'manual', { timeoutMs: 100 })).rejects.toThrow(/too long/);
  });
});
