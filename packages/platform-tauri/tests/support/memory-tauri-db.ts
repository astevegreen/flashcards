import { InMemorySqliteDriver } from '../../../platform-capacitor/tests/support/in-memory-sqlite-driver.ts';
import type { TauriSqlPluginDatabase } from '../../src/storage/tauri-sqlite-storage.ts';

/** A `@tauri-apps/plugin-sql` stand-in over the test-only SQLite emulator (N9). */
export function memoryTauriDb(): TauriSqlPluginDatabase {
  const driver = new InMemorySqliteDriver();
  return {
    execute: async (sql, params) => {
      await driver.execute(sql, params);
      return { rowsAffected: 0 };
    },
    select: (sql, params) => driver.query(sql, params),
  };
}
