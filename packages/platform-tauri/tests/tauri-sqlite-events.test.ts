import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createEventFactory, createHlcState } from '@flash/core';
import { describe, expect, it } from 'vitest';
import { TauriSqliteStorage, type TauriSqlPluginDatabase } from '../src/index.ts';

/**
 * Real SQLite (node:sqlite) behind the tauri-plugin-sql shape. `executeBatch` stands in for the
 * `sql_execute_batch` command (apps/desktop/src-tauri/src/sql_batch.rs): one transaction.
 */
function sqliteDb(db = new DatabaseSync(':memory:')): TauriSqlPluginDatabase {
  const run = (q: string, binds: readonly unknown[] = []) =>
    db.prepare(q).run(...(binds as SQLInputValue[]));
  return {
    execute: async (q, binds) => ({ rowsAffected: Number(run(q, binds).changes) }),
    select: async <T>(q: string, binds: unknown[] = []) =>
      db.prepare(q).all(...(binds as SQLInputValue[])) as T[],
    executeBatch: async (statements) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const { sql, params } of statements) run(sql, params);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

const hlc = createHlcState('desk-1', 1_750_000_000_000);
const events = (seq: number, n: number) => {
  const f = createEventFactory('desk-1', seq, hlc);
  return Array.from({ length: n }, () =>
    f.create('PreferencesChanged', { preferences: {} }, 1_750_000_000_100),
  );
};

describe('TauriSqliteStorage events and meta (D11)', () => {
  it('writes events with their meta in one transaction, and a failing meta write keeps neither', async () => {
    const raw = new DatabaseSync(':memory:');
    const storage = new TauriSqliteStorage(sqliteDb(raw));
    await storage.appendEventsWithMeta(events(0, 2), { deviceId: 'desk-1', seq: 2, hlc });
    expect((await storage.getDeviceMeta())?.seq).toBe(2);

    raw.exec(`CREATE TRIGGER fail_meta BEFORE INSERT ON kv WHEN NEW.key = '__device_meta'
              BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL'); END`);
    await expect(
      storage.appendEventsWithMeta(events(2, 2), { deviceId: 'desk-1', seq: 4, hlc }),
    ).rejects.toThrow('SQLITE_FULL');
    expect((await storage.getAllEvents()).map((e) => e.seq)).toEqual([1, 2]);
    expect((await storage.getDeviceMeta())?.seq).toBe(2);
  });
});
