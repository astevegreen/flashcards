import type { StoredBackupInfo } from '@flash/platform';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CapacitorSqliteStorage, type SqliteDriver } from '../src/storage/sqlite-storage.ts';

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

/** A real SQLite engine (sql.js) behind the driver, so the SQL itself is exercised. */
async function sqlJsDriver(): Promise<SqliteDriver> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  return {
    execute: async (sql, params = []) => {
      db.run(sql, params as never);
    },
    query: async <T>(sql: string, params: readonly unknown[] = []) => {
      const stmt = db.prepare(sql);
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      stmt.free();
      return rows;
    },
  };
}

describe.each([
  ['in-memory driver', async () => new CapacitorSqliteStorage()],
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
});
