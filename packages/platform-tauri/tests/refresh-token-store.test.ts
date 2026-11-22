import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createSqliteRefreshTokenStore,
  resolveRefreshTokenStore,
  type SecureSecretBackend,
  type TauriSqlPluginDatabase,
} from '../src/index.ts';

/** Real SQLite behind the tauri-plugin-sql shape (`$1` placeholders become `?1`). */
function sqliteDb(): TauriSqlPluginDatabase & { tables(): string[] } {
  const db = new DatabaseSync(':memory:');
  const prep = (q: string) => db.prepare(q.replace(/\$(\d+)/g, '?$1'));
  return {
    execute: async (q, binds = []) => ({
      rowsAffected: Number(prep(q).run(...(binds as string[])).changes),
    }),
    select: async <T>(q: string, binds: unknown[] = []) =>
      prep(q).all(...(binds as string[])) as T[],
    tables: () =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
  };
}

function fakeKeychain(opts: { available?: boolean; failSet?: boolean } = {}) {
  const entries = new Map<string, string>();
  const backend: SecureSecretBackend = {
    isAvailable: async () => opts.available ?? true,
    get: async (account) => entries.get(account),
    set: async (account, secret) => {
      if (opts.failSet) throw new Error('keychain locked');
      entries.set(account, secret);
    },
    delete: async (account) => {
      entries.delete(account);
    },
  };
  return { backend, entries };
}

const ACCOUNT = 'google-refresh-token';

describe('desktop refresh-token storage', () => {
  it('moves an existing SQLite token into the keychain and drops the table', async () => {
    const db = sqliteDb();
    const legacy = createSqliteRefreshTokenStore(db, 'google');
    await legacy.set('old-refresh-token');
    expect(db.tables()).toContain('oauth_refresh_tokens');

    const { backend, entries } = fakeKeychain();
    const warnings: string[] = [];
    const resolved = await resolveRefreshTokenStore({
      secure: backend,
      legacy,
      account: ACCOUNT,
      onInsecureFallback: (r) => warnings.push(r),
    });

    expect(resolved.mode).toBe('keychain');
    expect(warnings).toEqual([]);
    expect(entries.get(ACCOUNT)).toBe('old-refresh-token');
    expect(db.tables()).not.toContain('oauth_refresh_tokens');
    expect(await resolved.store.get()).toBe('old-refresh-token');

    await resolved.store.set('new-refresh-token');
    expect(entries.get(ACCOUNT)).toBe('new-refresh-token');
    await resolved.store.delete();
    expect(await resolved.store.get()).toBeUndefined();
    expect(db.tables()).not.toContain('oauth_refresh_tokens');
  });

  it('keeps the keychain token when SQLite has none', async () => {
    const db = sqliteDb();
    const { backend, entries } = fakeKeychain();
    entries.set(ACCOUNT, 'keychain-token');
    const resolved = await resolveRefreshTokenStore({
      secure: backend,
      legacy: createSqliteRefreshTokenStore(db, 'google'),
      account: ACCOUNT,
    });
    expect(resolved.mode).toBe('keychain');
    expect(await resolved.store.get()).toBe('keychain-token');
    expect(db.tables()).toEqual([]);
  });

  it('falls back to SQLite with a warning when no keychain is available', async () => {
    const db = sqliteDb();
    const { backend, entries } = fakeKeychain({ available: false });
    const warnings: string[] = [];
    const resolved = await resolveRefreshTokenStore({
      secure: backend,
      legacy: createSqliteRefreshTokenStore(db, 'google'),
      account: ACCOUNT,
      onInsecureFallback: (r) => warnings.push(r),
    });

    expect(resolved.mode).toBe('sqlite');
    expect(warnings).toHaveLength(1);
    expect(await resolved.store.get()).toBeUndefined();
    await resolved.store.set('linux-token');
    expect(await resolved.store.get()).toBe('linux-token');
    expect(entries.size).toBe(0);
    await resolved.store.delete();
    expect(await resolved.store.get()).toBeUndefined();
  });

  it('treats a failing availability check as no keychain', async () => {
    const { backend } = fakeKeychain();
    backend.isAvailable = async () => {
      throw new Error('command not found');
    };
    const resolved = await resolveRefreshTokenStore({
      secure: backend,
      legacy: createSqliteRefreshTokenStore(sqliteDb(), 'google'),
      account: ACCOUNT,
    });
    expect(resolved.mode).toBe('sqlite');
  });

  it('leaves the SQLite token in place if moving it fails', async () => {
    const db = sqliteDb();
    const legacy = createSqliteRefreshTokenStore(db, 'google');
    await legacy.set('old-refresh-token');
    const { backend } = fakeKeychain({ failSet: true });
    const warnings: string[] = [];
    const resolved = await resolveRefreshTokenStore({
      secure: backend,
      legacy,
      account: ACCOUNT,
      onInsecureFallback: (r) => warnings.push(r),
    });
    expect(resolved.mode).toBe('sqlite');
    expect(warnings[0]).toMatch(/keychain locked/);
    expect(await resolved.store.get()).toBe('old-refresh-token');
  });

  it('prefers a newer SQLite token over an older keychain copy', async () => {
    const db = sqliteDb();
    const legacy = createSqliteRefreshTokenStore(db, 'google');
    await legacy.set('signed-in-while-keychain-was-down');
    const { backend, entries } = fakeKeychain();
    entries.set(ACCOUNT, 'stale-token');
    const resolved = await resolveRefreshTokenStore({ secure: backend, legacy, account: ACCOUNT });
    expect(await resolved.store.get()).toBe('signed-in-while-keychain-was-down');
  });

  it('two providers share the table: one falling back never loses the other token', async () => {
    const db = sqliteDb();
    // Google signed in while the keychain refused writes, so its token stayed in SQLite.
    const google = createSqliteRefreshTokenStore(db, 'google');
    const lockedKeychain = fakeKeychain({ failSet: true });
    await google.set('google-sqlite-token');
    const googleResolved = await resolveRefreshTokenStore({
      secure: lockedKeychain.backend,
      legacy: google,
      account: ACCOUNT,
    });
    expect(googleResolved.mode).toBe('sqlite');

    // Later the keychain works: the Microsoft store moves (nothing) and must not drop the table.
    const { backend, entries } = fakeKeychain();
    const microsoft = createSqliteRefreshTokenStore(db, 'microsoft');
    const msResolved = await resolveRefreshTokenStore({
      secure: backend,
      legacy: microsoft,
      account: 'microsoft-refresh-token',
    });
    expect(msResolved.mode).toBe('keychain');
    expect(db.tables()).toContain('oauth_refresh_tokens');
    expect(await google.get()).toBe('google-sqlite-token');

    // The other way round: a Microsoft token left in SQLite survives Google's move.
    await microsoft.set('ms-sqlite-token');
    const googleMoved = await resolveRefreshTokenStore({
      secure: backend,
      legacy: google,
      account: ACCOUNT,
    });
    expect(googleMoved.mode).toBe('keychain');
    expect(entries.get(ACCOUNT)).toBe('google-sqlite-token');
    expect(await microsoft.get()).toBe('ms-sqlite-token');
    expect(await google.get()).toBeUndefined();

    // Once the last provider has moved, the table is gone.
    await resolveRefreshTokenStore({
      secure: backend,
      legacy: microsoft,
      account: 'microsoft-refresh-token',
    });
    expect(entries.get('microsoft-refresh-token')).toBe('ms-sqlite-token');
    expect(db.tables()).not.toContain('oauth_refresh_tokens');
  });
});
