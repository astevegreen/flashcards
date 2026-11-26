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
import { advanceClockPastOwnEvents } from '@flash/core/sync';
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

  it('round-trips the local snapshot, sync cursor/config and kv, and clearAll empties them', async () => {
    const storage = createTestStorage('kv');

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
    expect(await storage.getLocalSnapshot()).toBeUndefined();
    expect(await storage.getSyncCursor()).toBeUndefined();
    expect(await storage.getSyncConfig()).toBeUndefined();

    storage.close();
  });
});

/** The stores of the v3 schema, as the builds before P5 declare them. */
const V3_STORES = {
  events: 'id, [device+seq], hlc, type, card_id, local_seq',
  cards_cache: 'id, deck_id, due',
  meta: 'key',
  media: 'hash',
  snapshots: 'key',
  kv: 'key',
  backups: 'backup_id, created_at',
  backup_blobs: 'id',
};

describe('v4: the unread card cache is emptied (P5)', () => {
  const cacheRow = { id: 'c1', deck_id: 'd1', note_id: 'n1', layout_id: 'l1', due: 1000 };

  it('upgrades a v3 database without touching events, snapshot or kv', async () => {
    const slug = `upgrade-v4-${Date.now()}`;
    const dbName = `flashcards-db-${slug}`;
    createdDbs.push(dbName);

    // A v3 database as a pre-P5 build leaves it: two events, a snapshot, a filled card cache.
    const v3 = new Dexie(dbName);
    v3.version(3).stores(V3_STORES);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 1_760_000_000_000));
    const ev1 = factory.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 4 } },
      1_760_000_000_000,
    );
    const ev2 = factory.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 5 } },
      1_760_000_001_000,
    );
    await v3.table('events').bulkPut([
      { ...ev1, local_seq: 1 },
      { ...ev2, local_seq: 2 },
    ]);
    await v3.table('kv').put({ key: '__local_seq_counter', value: 2 });
    const snapshot = serializeCollectionState(applyEvents(createEmptyState(), [ev1]), {
      'dev-a': 1,
    });
    await v3
      .table('snapshots')
      .put({ key: 'latest', value: { snapshot, localSeq: 1, savedAt: 7 } });
    await v3.table('cards_cache').bulkPut([cacheRow, { ...cacheRow, id: 'c2' }]);
    v3.close();

    const storage = new DexieStorage(slug);
    expect((await storage.getAllEvents()).map((e) => e.id)).toEqual([ev1.id, ev2.id]);
    expect(await storage.getMaxLocalSeq()).toBe(2);
    const snap = await storage.getLocalSnapshot();
    expect(snap?.localSeq).toBe(1);
    expect(snap?.snapshot.watermarks).toEqual({ 'dev-a': 1 });
    const delta = await storage.getEventsAfterLocalSeq(1);
    expect(delta.events.map((e) => e.id)).toEqual([ev2.id]);

    // New events keep counting from the stored local_seq.
    const ev3 = factory.create(
      'PreferencesChanged',
      { preferences: { day_start_hour: 6 } },
      1_760_000_002_000,
    );
    await storage.appendEvents([ev3]);
    expect((await storage.getEventsAfterLocalSeq(2)).maxLocalSeq).toBe(3);
    storage.close();

    const raw = await new Dexie(dbName).open();
    expect(raw.verno).toBe(4);
    expect(await raw.table('cards_cache').count()).toBe(0);
    raw.close();
  });

  it('lets a stale tab on a v3 build still open the upgraded database and write its cache', async () => {
    const storage = createTestStorage('stale-tab');
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 1_760_000_000_000));
    const ev = factory.create('PreferencesChanged', { preferences: {} }, 1_760_000_000_000);
    await storage.appendEvents([ev]);
    storage.close();

    // A PWA tab not yet reloaded onto this build declares v3; Dexie opens the v4 database anyway.
    const stale = new Dexie(storage.dbName);
    stale.version(3).stores(V3_STORES);
    await stale.open();
    // Dexie stores version n as IndexedDB version n * 10.
    expect(stale.backendDB().version).toBe(40);
    await stale.table('cards_cache').put(cacheRow);
    expect(await stale.table('cards_cache').count()).toBe(1);
    expect(await stale.table('events').count()).toBe(1);
    stale.close();
  });
});

describe('device meta behind stored events (D11)', () => {
  it('finds the events a killed session stored after its last meta write', async () => {
    const storage = createTestStorage('d11');
    const hlc = createHlcState('dev-a', 1_750_000_000_000);
    await storage.setDeviceMeta({ deviceId: 'dev-a', seq: 1, hlc });
    const f = createEventFactory('dev-a', 0, hlc);
    const events = [1, 2, 3].map(() =>
      f.create('PreferencesChanged', { preferences: {} }, 1_750_000_000_100),
    );
    await storage.appendEvents(events); // ...and the tab closed before setDeviceMeta ran

    const meta = await storage.getDeviceMeta();
    if (!meta) throw new Error('meta missing');
    const tail = await storage.getDeviceEventsAfterSeq(meta.deviceId, meta.seq);
    expect(tail.map((e) => e.seq)).toEqual([2, 3]);
    const repaired = { ...meta, ...advanceClockPastOwnEvents(meta, tail) };
    expect(repaired.seq).toBe(3);
    expect(repaired.hlc.wallMs).toBe(1_750_000_000_100);
  });
});

describe('appendEventsWithMeta (D11)', () => {
  const hlc = createHlcState('dev-a', 1_750_000_000_000);
  const eventsFrom = (seq: number, n: number) => {
    const f = createEventFactory('dev-a', seq, hlc);
    return Array.from({ length: n }, () =>
      f.create('PreferencesChanged', { preferences: {} }, 1_750_000_000_100),
    );
  };

  it('stores the events and the meta that counts them together', async () => {
    const storage = createTestStorage('with-meta');
    const events = eventsFrom(0, 3);
    await storage.appendEventsWithMeta(events, { deviceId: 'dev-a', seq: 3, hlc });
    expect((await storage.getAllEvents()).map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect((await storage.getDeviceMeta())?.seq).toBe(3);
    expect(await storage.getMaxLocalSeq()).toBe(3);
    // A retried write of the same events is idempotent and still moves the meta.
    await storage.appendEventsWithMeta(events, { deviceId: 'dev-a', seq: 4, hlc });
    expect(await storage.getAllEvents()).toHaveLength(3);
    expect((await storage.getDeviceMeta())?.seq).toBe(4);
  });

  it('a failing meta write leaves no events appended', async () => {
    const storage = createTestStorage('with-meta-fail');
    await storage.setDeviceMeta({ deviceId: 'dev-a', seq: 0, hlc });
    // A function can't be stored in IndexedDB, so the meta put fails inside the transaction.
    const unstorable = { deviceId: 'dev-a', seq: 2, hlc, bad: () => 0 } as never;
    await expect(storage.appendEventsWithMeta(eventsFrom(0, 2), unstorable)).rejects.toThrow();
    expect(await storage.getAllEvents()).toEqual([]);
    expect(await storage.getMaxLocalSeq()).toBe(0);
    expect((await storage.getDeviceMeta())?.seq).toBe(0);
  });
});
