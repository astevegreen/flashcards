import {
  CapacitorSqliteStorage,
  InMemorySqliteDriver,
  type SqliteDriver,
} from '@flash/platform-capacitor';

/** Interface matching `@tauri-apps/plugin-sql` database instance. */
export interface TauriSqlPluginDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T = Record<string, unknown>>(query: string, bindValues?: unknown[]): Promise<T[]>;
}

/**
 * Adapts a Tauri SQL plugin database instance (or in-memory fallback for tests)
 * to the unified local-first SQLite `Storage` implementation (§10.1, §14, §15 Phase 8).
 */
export class TauriSqliteStorage extends CapacitorSqliteStorage {
  constructor(db?: TauriSqlPluginDatabase) {
    const driver: SqliteDriver = db
      ? {
          execute: async (sql, params) => {
            await db.execute(sql, params ? [...params] : undefined);
          },
          query: async <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
            db.select<T>(sql, params ? [...params] : undefined),
        }
      : new InMemorySqliteDriver();
    super(driver);
  }
}
