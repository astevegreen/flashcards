import { describe, expect, it } from 'vitest';
import {
  CapacitorSqliteStorage,
  createCapacitorPlatform,
  type SqliteDriver,
} from '../src/index.ts';
import { InMemorySqliteDriver } from './support/in-memory-sqlite-driver.ts';

describe('no silent in-memory database (N9)', () => {
  it('a storage without a driver is an error, not an emulator that loses data', () => {
    const missing = undefined as unknown as SqliteDriver;
    expect(() => new CapacitorSqliteStorage(missing)).toThrow(/needs a SQLite driver/);
    expect(() => createCapacitorPlatform({ deviceId: 'phone' })).toThrow(
      /needs `storage` or `sqliteDriver`/,
    );
  });

  it('the test emulator still works when passed explicitly', async () => {
    const storage = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    await storage.setKv('k', { v: 1 });
    expect(await storage.getKv('k')).toEqual({ v: 1 });
  });
});
