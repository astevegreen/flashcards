import type { TauriSqlPluginDatabase } from '../storage/tauri-sqlite-storage.ts';

/** Where the desktop loopback OAuth flow keeps its long-lived refresh token. */
export interface RefreshTokenStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

/** The pre-keychain SQLite table, kept as the fallback when no OS keychain is available. */
export interface LegacyRefreshTokenStore extends RefreshTokenStore {
  /** Removes the legacy storage entirely once its token has moved to the keychain. */
  drop(): Promise<void>;
}

/** OS keychain accessors exposed by the desktop shell (`apps/desktop/src-tauri/src/secure_store.rs`). */
export interface SecureSecretBackend {
  isAvailable(): Promise<boolean>;
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const LEGACY_TABLE = 'oauth_refresh_tokens';

/**
 * The `oauth_refresh_tokens` table used before the keychain move. The table is created only
 * when a token has to be written to it, so keychain systems never get it back.
 */
export function createSqliteRefreshTokenStore(
  db: TauriSqlPluginDatabase,
  provider: string,
): LegacyRefreshTokenStore {
  const tableExists = async () =>
    (
      await db.select<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1",
        [LEGACY_TABLE],
      )
    ).length > 0;
  return {
    get: async () => {
      if (!(await tableExists())) return undefined;
      const rows = await db.select<{ token: string }>(
        `SELECT token FROM ${LEGACY_TABLE} WHERE provider = $1`,
        [provider],
      );
      return rows[0]?.token;
    },
    set: async (token) => {
      await db.execute(
        `CREATE TABLE IF NOT EXISTS ${LEGACY_TABLE} (provider TEXT PRIMARY KEY, token TEXT NOT NULL)`,
      );
      await db.execute(
        `INSERT INTO ${LEGACY_TABLE} (provider, token) VALUES ($1, $2) ON CONFLICT(provider) DO UPDATE SET token = excluded.token`,
        [provider, token],
      );
    },
    delete: async () => {
      if (!(await tableExists())) return;
      await db.execute(`DELETE FROM ${LEGACY_TABLE} WHERE provider = $1`, [provider]);
    },
    drop: async () => {
      await db.execute(`DROP TABLE IF EXISTS ${LEGACY_TABLE}`);
    },
  };
}

export type RefreshTokenStorageMode = 'keychain' | 'sqlite';

export interface ResolvedRefreshTokenStore {
  store: RefreshTokenStore;
  mode: RefreshTokenStorageMode;
}

/**
 * Picks the OS keychain when the shell reports one, moving any token left in the legacy SQLite
 * table into it first. Falls back to SQLite (and reports why) when the keychain is missing or
 * the move fails, so sign-in keeps working on Linux desktops without a Secret Service.
 *
 * A token found in SQLite always wins over the keychain copy: it can only be there if the last
 * sign-in happened while the keychain was unavailable, which makes it the newest one.
 */
export async function resolveRefreshTokenStore(opts: {
  secure: SecureSecretBackend;
  legacy: LegacyRefreshTokenStore;
  account: string;
  onInsecureFallback?: (reason: string) => void;
}): Promise<ResolvedRefreshTokenStore> {
  const { secure, legacy, account } = opts;
  const fallback = (reason: string): ResolvedRefreshTokenStore => {
    opts.onInsecureFallback?.(reason);
    return { store: legacy, mode: 'sqlite' };
  };

  const available = await secure.isAvailable().catch(() => false);
  if (!available) return fallback('No OS keychain is available on this system.');

  try {
    const legacyToken = await legacy.get();
    if (legacyToken) await secure.set(account, legacyToken);
    await legacy.drop();
  } catch (err) {
    return fallback(
      `Could not move the sign-in token to the OS keychain: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    mode: 'keychain',
    store: {
      get: () => secure.get(account),
      set: (token) => secure.set(account, token),
      delete: () => secure.delete(account),
    },
  };
}
