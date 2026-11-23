import type { Storage } from '@flash/platform';
import type { SecureStore } from './secure-store.ts';

/** Prefix of a routed `Storage` KV entry inside the secure store. */
const SECURE_KV_PREFIX = 'kv.';

/**
 * Plain SQLite KV flag set once the launch sweep has moved every legacy row, so later launches skip
 * it. Holds no secret. Rows that appear afterwards (e.g. after a downgrade) are still moved lazily
 * by `getKv`.
 */
export const SECURE_KV_MIGRATED_KEY = 'secure_kv_migrated_v1';

export interface SecureKvRouting {
  /**
   * The app `Storage` with the routed KV keys read from and written to the secure store. Every other
   * member goes straight to the wrapped storage. `clearAll` also deletes the secrets.
   */
  storage: Storage;
  /**
   * Moves every routed key still in the wrapped storage into the secure store (copy, then delete).
   * Runs once per database (`SECURE_KV_MIGRATED_KEY`).
   */
  migrateLegacyRows(): Promise<void>;
  /** Deletes every secret this routing owns (routed KV keys and `extraSecretKeys`). */
  removeSecrets(): Promise<void>;
}

/**
 * Keeps the secret-bearing KV entries (`SECURE_KV_KEYS`) out of SQLite. A row left in SQLite by an
 * older build is moved on first read, and `migrateLegacyRows` moves them all eagerly at launch. A
 * secure-store failure is thrown to the caller: there is never a fallback to the wrapped storage.
 *
 * Decrypted values are cached in memory for the session, so a token read costs one native call
 * (a Keystore decrypt on Android) per launch rather than one per read. Only this routing writes the
 * `kv.` entries, so the cache cannot go stale.
 */
export function createSecureKvRouting(options: {
  inner: Storage;
  secureStore: SecureStore;
  kvKeys: readonly string[];
  /** Other secure-store keys (e.g. refresh tokens) wiped with the routed KV keys. */
  extraSecretKeys?: readonly string[];
}): SecureKvRouting {
  const { inner, secureStore } = options;
  const routed = new Set(options.kvKeys);
  const secureKey = (key: string) => `${SECURE_KV_PREFIX}${key}`;
  /** Raw JSON of routed keys known to be in the secure store, keyed by KV key. */
  const cache = new Map<string, string>();

  const readSecure = async (key: string): Promise<string | null> => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const raw = await secureStore.get(secureKey(key));
    if (raw !== null) cache.set(key, raw);
    return raw;
  };

  const writeSecure = async (key: string, raw: string): Promise<void> => {
    cache.delete(key);
    await secureStore.set(secureKey(key), raw);
    cache.set(key, raw);
  };

  const removeSecure = async (key: string): Promise<void> => {
    cache.delete(key);
    await secureStore.remove(secureKey(key));
  };

  const moveLegacyRow = async <T>(key: string): Promise<T | undefined> => {
    const legacy = await inner.getKv<T>(key);
    if (legacy === undefined) return undefined;
    await writeSecure(key, JSON.stringify(legacy));
    await inner.deleteKv(key);
    return legacy;
  };

  const getKv = async <T = unknown>(key: string): Promise<T | undefined> => {
    if (!routed.has(key)) return inner.getKv<T>(key);
    const raw = await readSecure(key);
    if (raw !== null) return JSON.parse(raw) as T;
    return moveLegacyRow<T>(key);
  };

  const setKv = async (key: string, value: unknown): Promise<void> => {
    if (!routed.has(key)) return inner.setKv(key, value);
    await writeSecure(key, JSON.stringify(value));
    // Drops a row an older build may have left behind.
    await inner.deleteKv(key);
  };

  const deleteKv = async (key: string): Promise<void> => {
    if (!routed.has(key)) return inner.deleteKv(key);
    await removeSecure(key);
    await inner.deleteKv(key);
  };

  const removeSecrets = async (): Promise<void> => {
    for (const key of routed) await removeSecure(key);
    for (const key of options.extraSecretKeys ?? []) await secureStore.remove(key);
  };

  const clearAll = async (): Promise<void> => {
    await inner.clearAll();
    await removeSecrets();
  };

  const overrides = new Map<PropertyKey, unknown>([
    ['getKv', getKv],
    ['setKv', setKv],
    ['deleteKv', deleteKv],
    ['clearAll', clearAll],
  ]);

  const storage = new Proxy(inner, {
    get(target, prop) {
      if (overrides.has(prop)) return overrides.get(prop);
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    storage,
    migrateLegacyRows: async () => {
      if ((await inner.getKv(SECURE_KV_MIGRATED_KEY)) !== undefined) return;
      for (const key of routed) {
        if ((await readSecure(key)) === null) {
          await moveLegacyRow(key);
        } else {
          // The secure copy is authoritative; a stale SQLite row is just deleted.
          await inner.deleteKv(key);
        }
      }
      await inner.setKv(SECURE_KV_MIGRATED_KEY, true);
    },
    removeSecrets,
  };
}
