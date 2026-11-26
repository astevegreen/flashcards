import { describe, expect, it } from 'vitest';
import { createTauriPlatform, TauriSqliteStorage } from '../src/index.ts';

describe('no silent in-memory database (N9)', () => {
  it('a desktop storage without a database is an error', () => {
    type Db = ConstructorParameters<typeof TauriSqliteStorage>[0];
    expect(() => new TauriSqliteStorage(undefined as unknown as Db)).toThrow(
      /needs a Tauri SQL database/,
    );
    expect(() =>
      createTauriPlatform({ deviceId: 'win' } as Parameters<typeof createTauriPlatform>[0]),
    ).toThrow(/needs a Tauri SQL database/);
  });
});
