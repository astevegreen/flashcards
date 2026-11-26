import { createEventFactory, createHlcState, type FlashEvent } from '@flash/core';
import { advanceClockPastOwnEvents } from '@flash/core/sync';
import type { DeviceMeta } from '@flash/platform';
import { describe, expect, it } from 'vitest';
import { CapacitorSqliteStorage, type SqliteDriver } from '../src/storage/sqlite-storage.ts';
import { InMemorySqliteDriver } from './support/in-memory-sqlite-driver.ts';
import { sqlJsDriver } from './support/sql-js-driver.ts';

const DEVICE = 'cap-ios-1';
const HLC = createHlcState(DEVICE, 1_750_000_000_000);

function eventsFrom(seq: number, n: number): FlashEvent[] {
  const f = createEventFactory(DEVICE, seq, HLC);
  return Array.from({ length: n }, (_, i) =>
    f.create('PreferencesChanged', { preferences: {} }, 1_750_000_000_100 + seq + i),
  );
}

function metaAt(seq: number): DeviceMeta {
  return { deviceId: DEVICE, seq, hlc: HLC };
}

/** Throws inside the write, the way a full disk would, for the statement `fails` picks. */
type Failure = 'meta' | { eventId: string };

interface DriverKind {
  make(): Promise<SqliteDriver>;
  /** The same database after an app restart. */
  reopen(driver: SqliteDriver): Promise<SqliteDriver>;
  /** Makes later writes matching `failure` fail inside their transaction. */
  failing(driver: SqliteDriver, failure: Failure): Promise<SqliteDriver>;
}

class FailingMemoryDriver extends InMemorySqliteDriver {
  failure: Failure | null = null;

  override async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    const f = this.failure;
    if (f === 'meta' && sql.includes('INTO kv') && params[0] === '__device_meta') {
      throw new Error('SQLITE_FULL');
    }
    if (f && f !== 'meta' && sql.includes('INTO events') && params[0] === f.eventId) {
      throw new Error('SQLITE_FULL');
    }
    await super.execute(sql, params);
  }
}

const memory: DriverKind = {
  make: async () => new FailingMemoryDriver(),
  reopen: async (driver) => driver,
  failing: async (driver, failure) => {
    (driver as FailingMemoryDriver).failure = failure;
    return driver;
  },
};

const sqlJs: DriverKind = {
  make: () => sqlJsDriver(),
  reopen: async (driver) =>
    sqlJsDriver((driver as Awaited<ReturnType<typeof sqlJsDriver>>).db.export()),
  failing: async (driver, failure) => {
    // A trigger makes real SQLite fail the statement part way through the transaction.
    const { db } = driver as Awaited<ReturnType<typeof sqlJsDriver>>;
    if (failure === 'meta') {
      db.run(`CREATE TRIGGER fail_meta BEFORE INSERT ON kv WHEN NEW.key = '__device_meta'
              BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL'); END`);
    } else {
      db.run(`CREATE TRIGGER fail_event BEFORE INSERT ON events WHEN NEW.id = '${failure.eventId}'
              BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL'); END`);
    }
    return driver;
  },
};

describe.each([
  ['in-memory driver', memory],
  ['sql.js (real SQLite)', sqlJs],
])('CapacitorSqliteStorage events (%s)', (_label, kind) => {
  it('stores and queries events by hlc, device seq and local_seq, idempotently', async () => {
    const storage = new CapacitorSqliteStorage(await kind.make());
    const [ev1, ev2] = eventsFrom(0, 2);
    if (!ev1 || !ev2) throw new Error('no events');
    await storage.appendEvents([ev1, ev2]);
    await storage.appendEvents([ev1]);
    // A batch holding one event twice stores it once.
    await storage.appendEvents([ev2, ev2]);

    expect(await storage.getAllEvents()).toEqual([ev1, ev2]);
    expect((await storage.getDeviceEventsAfterSeq(DEVICE, 1)).map((e) => e.id)).toEqual([ev2.id]);
    expect(await storage.getMaxLocalSeq()).toBe(2);
    const delta = await storage.getEventsAfterLocalSeq(1);
    expect(delta.events.map((e) => e.id)).toEqual([ev2.id]);
    expect(delta.maxLocalSeq).toBe(2);
  });

  it('keeps unknown envelope fields and the card id of an event', async () => {
    const storage = new CapacitorSqliteStorage(await kind.make());
    const ev = {
      ...eventsFrom(0, 1)[0],
      type: 'ReviewRecorded',
      payload: { card_id: 'c1', rating: 3 },
      future_field: { x: 1 },
    } as unknown as FlashEvent;
    await storage.appendEvents([ev]);
    expect(await storage.getAllEvents()).toEqual([ev]);
  });

  it('stores the events and the meta that counts them together', async () => {
    const storage = new CapacitorSqliteStorage(await kind.make());
    const events = eventsFrom(0, 3);
    await storage.appendEventsWithMeta(events, metaAt(3));
    expect((await storage.getAllEvents()).map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(await storage.getDeviceMeta()).toEqual(metaAt(3));
    // No events: the meta alone.
    await storage.appendEventsWithMeta([], metaAt(4));
    expect((await storage.getDeviceMeta())?.seq).toBe(4);
  });

  it('a failing meta write leaves no events appended', async () => {
    const driver = await kind.make();
    const storage = new CapacitorSqliteStorage(driver);
    await storage.appendEventsWithMeta(eventsFrom(0, 1), metaAt(1));

    await kind.failing(driver, 'meta');
    await expect(storage.appendEventsWithMeta(eventsFrom(1, 2), metaAt(3))).rejects.toThrow(
      'SQLITE_FULL',
    );
    expect(await storage.getAllEvents()).toHaveLength(1);
    expect(await storage.getMaxLocalSeq()).toBe(1);
    expect((await storage.getDeviceMeta())?.seq).toBe(1);
  });

  it('a batch that fails halfway stores none of it', async () => {
    const driver = await kind.make();
    const storage = new CapacitorSqliteStorage(driver);
    const events = eventsFrom(0, 3);
    expect(await storage.getMaxLocalSeq()).toBe(0); // creates the tables
    await kind.failing(driver, { eventId: events[2]?.id ?? '' });
    await expect(storage.appendEvents(events)).rejects.toThrow('SQLITE_FULL');
    expect(await storage.getAllEvents()).toEqual([]);
  });

  it('continues the device seq after a restart, with nothing stored past the meta', async () => {
    const driver = await kind.make();
    const first = new CapacitorSqliteStorage(driver);
    await first.appendEventsWithMeta(eventsFrom(0, 2), metaAt(2));
    await first.appendEventsWithMeta(eventsFrom(2, 3), metaAt(5));

    const reopened = new CapacitorSqliteStorage(await kind.reopen(driver));
    const meta = await reopened.getDeviceMeta();
    if (!meta) throw new Error('meta missing');
    expect(meta.seq).toBe(5);
    // What boot checks (apps/web/src/main.tsx): no own event stored after the meta.
    expect(await reopened.getDeviceEventsAfterSeq(DEVICE, meta.seq)).toEqual([]);

    const next = eventsFrom(meta.seq, 1);
    await reopened.appendEventsWithMeta(next, metaAt(6));
    const seqs = (await reopened.getAllEvents()).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a batch too big for one transaction keeps its earlier slices, and boot moves the seq past them', async () => {
    const driver = await kind.make();
    const storage = new CapacitorSqliteStorage(driver);
    await storage.appendEventsWithMeta([], metaAt(0));
    const events = eventsFrom(0, 700);

    // The meta rides in the last transaction; failing it loses that slice only.
    await kind.failing(driver, 'meta');
    await expect(storage.appendEventsWithMeta(events, metaAt(700))).rejects.toThrow('SQLITE_FULL');
    const stored = await storage.getEventsAfterLocalSeq(0);
    expect(stored.events.map((e) => e.seq)).toEqual(events.slice(0, 500).map((e) => e.seq));

    const meta = await storage.getDeviceMeta();
    if (!meta) throw new Error('meta missing');
    expect(meta.seq).toBe(0);
    const tail = await storage.getDeviceEventsAfterSeq(DEVICE, meta.seq);
    expect(advanceClockPastOwnEvents(meta, tail).seq).toBe(500);
  });
});
