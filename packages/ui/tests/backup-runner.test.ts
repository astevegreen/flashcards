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
  listSyncFolderBackups,
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
  });

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
});
