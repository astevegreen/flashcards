import 'fake-indexeddb/auto';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  createInitialSyncCursor,
  serializeCollectionState,
  type FlashEvent,
  type UnknownEvent,
} from '@flash/core';
import type { MaterializedCardRow } from '@flash/platform';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieStorage } from '../src/storage/dexie-storage.ts';

const createdDbs: string[] = [];

function createTestStorage(suffix: string): DexieStorage {
  const slug = `test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const storage = new DexieStorage(slug);
  createdDbs.push(storage.dbName);
  return storage;
}

afterEach(async () => {
  while (createdDbs.length > 0) {
    const name = createdDbs.pop();
    if (name) {
      await Dexie.delete(name);
    }
  }
});

describe('DexieStorage v2 unit tests (fake-indexeddb)', () => {
  it('upgrades a v1 database to v2 cleanly and backfills monotonic local_seq', async () => {
    const slug = `upgrade-${Date.now()}`;
    const dbName = `flashcards-db-${slug}`;
    createdDbs.push(dbName);

    // Create a genuine Phase 1 v1 Dexie database first
    const v1Db = new Dexie(dbName);
    v1Db.version(1).stores({
      events: 'id, [device+seq], hlc, type, card_id',
      cards_cache: 'id, deck_id, due',
      meta: 'key',
      media: 'hash',
    });
    const factory = createEventFactory('dev-v1', 0, createHlcState('dev-v1', 1_700_000_000_000));
    const ev1 = factory.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 4 } },
      1_700_000_000_000,
    );
    const ev2 = factory.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 5 } },
      1_700_000_001_000,
    );
    await v1Db.table('events').bulkPut([ev1, ev2]);
    v1Db.close();

    // Open with v2 DexieStorage
    const storage = new DexieStorage(slug);
    const delta = await storage.getEventsAfterLocalSeq(0);
    expect(delta.events).toHaveLength(2);
    expect(delta.maxLocalSeq).toBe(2);
    expect(await storage.getMaxLocalSeq()).toBe(2);

    // Appending a 3rd event continues monotonic local_seq = 3
    const ev3 = factory.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 6 } },
      1_700_000_002_000,
    );
    await storage.appendEvents([ev3]);
    const after2 = await storage.getEventsAfterLocalSeq(2);
    expect(after2.events).toHaveLength(1);
    expect(after2.events[0]?.id).toBe(ev3.id);
    expect(after2.maxLocalSeq).toBe(3);

    storage.close();
  });

  it('appends events idempotently, preserves unknown envelope fields, and queries by [device+seq] and local_seq', async () => {
    const storage = createTestStorage('events');
    const fA = createEventFactory('dev-a', 0, createHlcState('dev-a', 1_750_000_000_000));
    const fB = createEventFactory('dev-b', 0, createHlcState('dev-b', 1_750_000_000_000));

    const a1 = fA.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 3 } },
      1_750_000_000_100,
    );
    const a2 = fA.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 4 } },
      1_750_000_000_200,
    );
    const b1: UnknownEvent & { future_flag: string } = {
      id: fB.create('PreferencesChanged', { preferences: {} }, 1_750_000_000_050).id,
      device: 'dev-b',
      seq: 1,
      hlc: '019500000000-0001-dev-b',
      type: 'FutureEvent',
      v: 2,
      payload: { hello: 'world' },
      future_flag: 'keep-me',
    };

    // Duplicate a1 in same batch + second append call must be ignored
    await storage.appendEvents([a1, a1, b1]);
    await storage.appendEvents([a1, a2]);

    expect(await storage.getMaxLocalSeq()).toBe(3);

    const devAEvents = await storage.getDeviceEventsAfterSeq('dev-a', 0);
    expect(devAEvents.map((e) => e.seq)).toEqual([1, 2]);

    const devAAfter1 = await storage.getDeviceEventsAfterSeq('dev-a', 1);
    expect(devAAfter1.map((e) => e.seq)).toEqual([2]);

    const devBEvents = await storage.getDeviceEventsAfterSeq('dev-b', 0);
    expect(devBEvents).toHaveLength(1);
    expect((devBEvents[0] as unknown as { future_flag?: string }).future_flag).toBe('keep-me');

    const deltaAfter1 = await storage.getEventsAfterLocalSeq(1);
    expect(deltaAfter1.events).toHaveLength(2);
    expect(deltaAfter1.maxLocalSeq).toBe(3);

    storage.close();
  });

  it('supports incremental cards_cache upsert/delete, local snapshot, sync cursor/config, kv, and clearAll', async () => {
    const storage = createTestStorage('cache-kv');

    const row1: MaterializedCardRow = {
      id: 'c1',
      deck_id: 'd1',
      note_id: 'n1',
      layout_id: 'l1',
      due: 1000,
      schedule: {
        due: 1000,
        stability: 1,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 2,
      },
    };
    const row2: MaterializedCardRow = { ...row1, id: 'c2', due: 2000 };

    await storage.upsertMaterializedCards([row1, row2]);
    expect(await storage.loadMaterializedCards()).toHaveLength(2);

    await storage.upsertMaterializedCards([{ ...row1, due: 5000 }]);
    await storage.deleteMaterializedCards(['c2']);
    const remaining = await storage.loadMaterializedCards();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe('c1');
    expect(remaining[0]?.due).toBe(5000);

    // Sync cursor, sync config, kv, and local snapshot round-trip
    const cursor = { ...createInitialSyncCursor('col-1'), lastPushedSeq: 5 };
    await storage.setSyncCursor(cursor);
    expect(await storage.getSyncCursor()).toEqual(cursor);

    await storage.setSyncConfig({ provider: 'google_drive', connectedAt: 12345 });
    expect(await storage.getSyncConfig()).toEqual({ provider: 'google_drive', connectedAt: 12345 });

    await storage.setKv('custom_key', { ok: true, count: 7 });
    expect(await storage.getKv('custom_key')).toEqual({ ok: true, count: 7 });
    await storage.deleteKv('custom_key');
    expect(await storage.getKv('custom_key')).toBeUndefined();

    const st = applyEvents(createEmptyState(), [] as FlashEvent[]);
    const snap = serializeCollectionState(st, { 'dev-a': 5 });
    await storage.setLocalSnapshot({ snapshot: snap, localSeq: 5, savedAt: 9999 });
    const loadedSnap = await storage.getLocalSnapshot();
    expect(loadedSnap?.localSeq).toBe(5);
    expect(loadedSnap?.snapshot.watermarks).toEqual({ 'dev-a': 5 });

    await storage.clearAll();
    expect(await storage.loadMaterializedCards()).toHaveLength(0);
    expect(await storage.getLocalSnapshot()).toBeUndefined();
    expect(await storage.getSyncCursor()).toBeUndefined();
    expect(await storage.getSyncConfig()).toBeUndefined();

    storage.close();
  });
});
