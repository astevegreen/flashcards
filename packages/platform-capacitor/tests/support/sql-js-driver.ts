/**
 * A real SQLite engine (sql.js, MIT, a devDependency only) behind `SqliteDriver`, so tests run the
 * storage's SQL itself rather than the `InMemorySqliteDriver` emulator's reading of it.
 */
import initSqlJs, { type SqlJsDatabase } from 'sql.js';
import type { SqliteDriver } from '../../src/storage/sqlite-storage.ts';

export interface SqlJsDriver extends SqliteDriver {
  /** The underlying database, for raw SQL in tests (triggers, exports). */
  readonly db: SqlJsDatabase;
}

/** Opens an empty database, or one from a file's bytes (`db.export()`: a reopen after a restart). */
export async function sqlJsDriver(bytes?: Uint8Array): Promise<SqlJsDriver> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(bytes);
  const run = (sql: string, params: readonly unknown[] = []) => {
    db.run(sql, params as never);
  };
  return {
    db,
    execute: async (sql, params) => {
      run(sql, params);
    },
    query: async <T>(sql: string, params: readonly unknown[] = []) => {
      const stmt = db.prepare(sql);
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      stmt.free();
      return rows;
    },
    executeBatch: async (statements) => {
      run('BEGIN IMMEDIATE');
      try {
        for (const { sql, params } of statements) run(sql, params);
        run('COMMIT');
      } catch (err) {
        run('ROLLBACK');
        throw err;
      }
    },
  };
}
