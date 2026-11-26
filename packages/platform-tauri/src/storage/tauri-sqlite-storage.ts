import { CapacitorSqliteStorage, type SqliteDriver } from '@flash/platform-capacitor';

/** Interface matching `@tauri-apps/plugin-sql` database instance. */
export interface TauriSqlPluginDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T = Record<string, unknown>>(query: string, bindValues?: unknown[]): Promise<T[]>;
}

/**
 * Adapts a Tauri SQL plugin database instance to the unified local-first SQLite `Storage`
 * implementation (§10.1, §14, §15 Phase 8). The database is required (N9): there is no in-memory
 * fallback that would silently lose data.
 */
export class TauriSqliteStorage extends CapacitorSqliteStorage {
  constructor(db: TauriSqlPluginDatabase) {
    if (!db) throw new Error('TauriSqliteStorage needs a Tauri SQL database; none was passed.');
    const driver: SqliteDriver = {
      execute: async (sql, params) => {
        await db.execute(sql, params ? [...params] : undefined);
      },
      query: async <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
        db.select<T>(sql, params ? [...params] : undefined),
    };
    super(driver);
  }
}
