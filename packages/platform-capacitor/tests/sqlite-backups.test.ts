import type { StoredBackupInfo } from '@flash/platform';
import { describe, expect, it } from 'vitest';
import { CapacitorSqliteStorage, type SqliteDriver } from '../src/storage/sqlite-storage.ts';
import { InMemorySqliteDriver } from './support/in-memory-sqlite-driver.ts';
import { sqlJsDriver } from './support/sql-js-driver.ts';

/** Mirrors `SNAPSHOT_CHUNK_CHARS` in sqlite-storage.ts. */
const SNAPSHOT_CHUNK_CHARS = 512 * 1024;

function info(id: string, createdAt: number): StoredBackupInfo {
  return {
    format_version: 1,
    backup_id: id,
    kind: 'full',
    reason: 'auto',
    created_at: createdAt,
    device_id: 'dev-a',
    total_events: 3,
    counts: { decks: 1, notes: 2, cards: 2, reviews: 1, media: 1 },
    media_hashes: ['ab'.repeat(32)],
    media_included: true,
    size_bytes: 3,
  };
}

describe.each([
  ['in-memory driver', async () => new CapacitorSqliteStorage(new InMemorySqliteDriver())],
  ['sql.js', async () => new CapacitorSqliteStorage(await sqlJsDriver())],
])('CapacitorSqliteStorage rolling backups (%s)', (_label, make) => {
  it('lists newest first, reads, deletes, and keeps backups across clearAll', async () => {
    const storage = await make();
    const store = await storage.openBackupStore();
    await store.put(info('old', 1), new Uint8Array([1, 2, 3]));
    await store.put(info('new', 2), new Uint8Array([4, 5, 6]));
    const listed = await store.list();
    expect(listed.map((b) => b.backup_id)).toEqual(['new', 'old']);
    expect(listed[0]?.media_hashes).toEqual(['ab'.repeat(32)]);
    expect([...((await store.getBytes('old')) ?? [])]).toEqual([1, 2, 3]);

    await storage.clearAll();
    expect(await store.list()).toHaveLength(2);

    await store.delete('old');
    expect((await store.list()).map((b) => b.backup_id)).toEqual(['new']);
    expect(await store.getBytes('old')).toBeUndefined();
  });

  it('stores a large archive in chunks and reads it back whole', async () => {
    const storage = await make();
    const store = await storage.openBackupStore();
    const big = new Uint8Array(2.5 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await store.put(info('big', 3), big);
    const back = await store.getBytes('big');
    expect(back?.byteLength).toBe(big.byteLength);
    expect(back?.[big.length - 1]).toBe(big[big.length - 1]);
    expect(back?.[1024 * 1024 + 7]).toBe(big[1024 * 1024 + 7]);
    // Rewriting with fewer bytes leaves no stale chunk behind.
    await store.put(info('big', 3), new Uint8Array([7, 8]));
    expect([...((await store.getBytes('big')) ?? [])]).toEqual([7, 8]);
    await store.delete('big');
    expect(await store.getBytes('big')).toBeUndefined();
  });

  it('keeps the media a kept backup lists across clearAll', async () => {
    const storage = await make();
    const kept = 'ab'.repeat(32);
    const dropped = 'cd'.repeat(32);
    for (const hash of [kept, dropped]) {
      await storage.putMedia({ hash, mime: 'image/png', bytes: new Uint8Array([1]) });
    }
    const store = await storage.openBackupStore();
    await store.put(info('daily', 1), new Uint8Array([1]));
    await storage.clearAll();
    expect(await storage.listMediaHashes()).toEqual([kept]);
  });

  it('deletes one media file (Check media)', async () => {
    const storage = await make();
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    await storage.putMedia({ hash: a, mime: 'image/png', bytes: new Uint8Array([1]) });
    await storage.putMedia({ hash: b, mime: 'image/png', bytes: new Uint8Array([2]) });
    await storage.deleteMedia(a);
    expect(await storage.listMediaHashes()).toEqual([b]);
    expect(await storage.getMedia(a)).toBeUndefined();
  });

  it('stores large local snapshots in bounded chunks and reads legacy unchunked ones', async () => {
    const storage = await make();
    const snapshot = { version: 2, bigText: '가'.repeat(1_200_000) } as never;
    await storage.setLocalSnapshot({ snapshot, localSeq: 42, savedAt: 1234 });
    expect(await storage.getKv('__local_snapshot')).toBeUndefined();
    expect(await storage.getLocalSnapshot()).toEqual({ snapshot, localSeq: 42, savedAt: 1234 });

    await storage.clearAll();
    expect(await storage.getLocalSnapshot()).toBeUndefined();

    // A legacy single-row `__local_snapshot` still loads when no chunked meta exists.
    const legacy = { snapshot: { version: 2 }, localSeq: 7, savedAt: 99 };
    await storage.setKv('__local_snapshot', legacy);
    expect(await storage.getLocalSnapshot()).toEqual(legacy);
  });

  it('keeps a surrogate pair whole when it straddles a chunk boundary', async () => {
    const storage = await make();
    // Puts the emoji's high surrogate on the last code unit of the first chunk.
    const head = '{"version":2,"t":"'.length;
    const t = 'a'.repeat(SNAPSHOT_CHUNK_CHARS - 1 - head) + '😀' + '가'.repeat(10);
    const snapshot = { version: 2, t } as never;
    await storage.setLocalSnapshot({ snapshot, localSeq: 1, savedAt: 1 });
    expect(await storage.getLocalSnapshot()).toEqual({ snapshot, localSeq: 1, savedAt: 1 });
  });

  it('runs overlapping snapshot writes one at a time, so the last one wins whole', async () => {
    const storage = await make();
    const a = { version: 2, t: 'a'.repeat(1_100_000) } as never;
    const b = { version: 2, t: 'b'.repeat(1_100_000) } as never;
    await Promise.all([
      storage.setLocalSnapshot({ snapshot: a, localSeq: 1, savedAt: 1 }),
      storage.setLocalSnapshot({ snapshot: b, localSeq: 2, savedAt: 2 }),
    ]);
    expect(await storage.getLocalSnapshot()).toEqual({ snapshot: b, localSeq: 2, savedAt: 2 });
  });

  it('pages events in order across page boundaries', async () => {
    const storage = await make();
    // hlc runs against insertion order, and neighbours share an hlc so the id tie-break is
    // exercised across the 500-row page boundary.
    const n = 1200;
    const batch = Array.from({ length: n }, (_, i) => {
      const j = n - 1 - i;
      return {
        id: `ev-${String(i).padStart(4, '0')}`,
        device: 'dev-a',
        seq: i + 1,
        hlc: `0000000000001:${String(Math.floor((j + 1) / 2)).padStart(4, '0')}:dev-a`,
        type: 'DeckCreated',
        v: 1,
        payload: { deck_id: `d-${i}` },
      };
    });
    await storage.appendEvents(batch as never);
    const byHlcThenId = [...batch].sort((x, y) =>
      x.hlc === y.hlc ? (x.id < y.id ? -1 : 1) : x.hlc < y.hlc ? -1 : 1,
    );
    expect((await storage.getAllEvents()).map((e) => e.id)).toEqual(byHlcThenId.map((e) => e.id));

    const all = await storage.getEventsAfterLocalSeq(0);
    expect(all.events.map((e) => e.id)).toEqual(batch.map((e) => e.id));
    expect(all.maxLocalSeq).toBe(n);
    const delta = await storage.getEventsAfterLocalSeq(100);
    expect(delta.events).toHaveLength(n - 100);
    expect(delta.events[0]?.id).toBe('ev-0100');
    expect(delta.maxLocalSeq).toBe(n);
  });
});

/** Fails the `n`th chunk insert, like a disk that fills up halfway through a write. */
function failingOnChunk(
  driver: SqliteDriver,
  n: number,
  insert = 'INSERT INTO backup_chunks',
): SqliteDriver {
  let chunks = 0;
  return {
    execute: async (sql, params) => {
      if (sql.startsWith(insert) && ++chunks === n) {
        throw new Error('SQLITE_FULL');
      }
      await driver.execute(sql, params);
    },
    query: (sql, params) => driver.query(sql, params),
    executeBatch: (statements) => driver.executeBatch(statements),
  };
}

/** How many of `backupId`'s first `upTo` chunks are stored. */
async function chunkCount(driver: SqliteDriver, backupId: string, upTo = 8): Promise<number> {
  let n = 0;
  for (let idx = 0; idx < upTo; idx++) {
    const rows = await driver.query(
      `SELECT b64 FROM backup_chunks WHERE backup_id = ? AND idx = ?`,
      [backupId, idx],
    );
    n += rows.length;
  }
  return n;
}

describe.each([
  ['in-memory driver', async (): Promise<SqliteDriver> => new InMemorySqliteDriver()],
  ['sql.js', sqlJsDriver],
])('CapacitorSqliteStorage backup writes that fail (%s)', (_label, makeDriver) => {
  it('keeps the previous local snapshot whole when a snapshot write fails halfway', async () => {
    const driver = await makeDriver();
    const kept = { snapshot: { version: 2, t: 'kept' } as never, localSeq: 1, savedAt: 1 };
    await new CapacitorSqliteStorage(driver).setLocalSnapshot(kept);
    const storage = new CapacitorSqliteStorage(
      failingOnChunk(driver, 2, 'INSERT INTO local_snapshot_chunks'),
    );
    const big = {
      snapshot: { version: 2, t: 'x'.repeat(1_100_000) } as never,
      localSeq: 2,
      savedAt: 2,
    };
    await expect(storage.setLocalSnapshot(big)).rejects.toThrow('SQLITE_FULL');
    expect(await new CapacitorSqliteStorage(driver).getLocalSnapshot()).toEqual(kept);
    // The queue is not stuck behind the failure.
    await storage.setLocalSnapshot(big);
    expect(await storage.getLocalSnapshot()).toEqual(big);
  });

  it('boots without a snapshot when a legacy row is too big to read back', async () => {
    const driver = await makeDriver();
    await new CapacitorSqliteStorage(driver).setKv('__local_snapshot', {
      snapshot: {},
      localSeq: 1,
    });
    const storage = new CapacitorSqliteStorage({
      execute: (sql, params) => driver.execute(sql, params),
      query: async (sql, params) => {
        if (sql.includes('FROM kv') && params?.[0] === '__local_snapshot') {
          throw new Error('Row too big to fit into CursorWindow');
        }
        return driver.query(sql, params);
      },
      executeBatch: (statements) => driver.executeBatch(statements),
    });
    expect(await storage.getLocalSnapshot()).toBeUndefined();
  });

  it('leaves no chunks or row behind when a write fails halfway', async () => {
    const driver = await makeDriver();
    const storage = new CapacitorSqliteStorage(failingOnChunk(driver, 3));
    const store = await storage.openBackupStore();
    const big = new Uint8Array(3.5 * 1024 * 1024).fill(7);
    await expect(store.put(info('big', 1), big)).rejects.toThrow('SQLITE_FULL');
    expect(await store.list()).toEqual([]);
    expect(await chunkCount(driver, 'big')).toBe(0);
  });

  it('sweeps chunks an interrupted write left behind at the next launch', async () => {
    const driver = await makeDriver();
    const first = await new CapacitorSqliteStorage(driver).openBackupStore();
    await first.put(info('kept', 1), new Uint8Array([1, 2, 3]));
    // An app killed mid-write: chunks in, no `backups` row.
    await driver.execute(`INSERT INTO backup_chunks (backup_id, idx, b64) VALUES (?, ?, ?)`, [
      'orphan',
      0,
      'AAAA',
    ]);
    expect(await chunkCount(driver, 'orphan')).toBe(1);
    const next = await new CapacitorSqliteStorage(driver).openBackupStore();
    expect(await chunkCount(driver, 'orphan')).toBe(0);
    expect(await chunkCount(driver, 'kept')).toBe(1);
    expect([...((await next.getBytes('kept')) ?? [])]).toEqual([1, 2, 3]);
  });
});

describe('the unread card cache (P5)', () => {
  it('drops a pre-P5 cards_cache table and keeps the events', async () => {
    const driver = await sqlJsDriver();
    const ev = {
      id: 'ev-1',
      device: 'dev-a',
      seq: 1,
      hlc: '0000000000001:0000:dev-a',
      type: 'DeckCreated',
      v: 1,
      payload: { deck_id: 'd' },
    };
    await new CapacitorSqliteStorage(driver).appendEvents([ev] as never);
    // The card cache a pre-P5 build created and filled next to the log.
    await driver.execute(`CREATE TABLE cards_cache (
      id TEXT PRIMARY KEY, deck_id TEXT NOT NULL, note_id TEXT NOT NULL, layout_id TEXT NOT NULL,
      due INTEGER NOT NULL, schedule_json TEXT NOT NULL)`);
    await driver.execute(`CREATE INDEX idx_cards_deck_due ON cards_cache(deck_id, due)`);
    await driver.execute(`INSERT INTO cards_cache VALUES ('c1', 'd', 'n', 'l', 1, '{}')`);

    // The next launch, on this build.
    const storage = new CapacitorSqliteStorage(driver);
    expect((await storage.getAllEvents()).map((e) => e.id)).toEqual(['ev-1']);
    const tables = await driver.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name IN ('cards_cache', 'idx_cards_deck_due')`,
    );
    expect(tables).toEqual([]);
  });
});
