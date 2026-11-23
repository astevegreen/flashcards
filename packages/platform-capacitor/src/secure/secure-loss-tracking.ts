/**
 * iOS Keychain loss detection (§13, §16). The Keychain items are `ThisDeviceOnly`, so they are not
 * carried to a new device when a backup is restored there, while the app database is. The Keychain
 * itself never says an item went missing, so each stored secret also leaves a plain marker in the
 * app database (the key name only, never the value). A secret that is missing while its marker
 * says it was stored was lost, and the app explains it once (`SECURE_KEYS_LOST_KV_KEY`).
 *
 * The deliberate wipe on a fresh install (`prepareSecureStorageAtLaunch` deleting Keychain items an
 * earlier install left behind) stays silent: a fresh database has no markers, and `remove` never
 * reports a loss. Android needs none of this: its plugin reports a lost Keystore key itself.
 */
import type { Storage } from '@flash/platform';
import type { MobilePlatform, NativeSecureStorage } from './secure-store.ts';

/** Prefix of the plain app-database marker saying "this secure-store key holds a secret". */
export const SECURE_STORED_MARKER_PREFIX = 'secure_stored_v1:';

/** The app-database KV entry that marks `key` as stored in the secure store. */
export function secureStoredMarkerKey(key: string): string {
  return `${SECURE_STORED_MARKER_PREFIX}${key}`;
}

/**
 * Wraps the secure store so a vanished secret is reported through `onSecretsLost`. `markers` must
 * be the unrouted app database (the markers hold no secret). Marker bookkeeping is best effort: a
 * failing marker write never fails the secret read or write it belongs to.
 */
export function trackStoredSecrets(options: {
  store: NativeSecureStorage;
  markers: Pick<Storage, 'getKv' | 'setKv' | 'deleteKv'>;
  onSecretsLost: () => void | Promise<void>;
}): NativeSecureStorage {
  const { store, markers } = options;
  /** Keys whose marker is known to be written this session, so a read checks it only once. */
  const marked = new Set<string>();

  const quietly = async (work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch {
      // Best effort: only the explanation of a later loss is at stake, never the secret itself.
    }
  };

  const ensureMarker = (key: string): Promise<void> =>
    marked.has(key)
      ? Promise.resolve()
      : quietly(async () => {
          const marker = secureStoredMarkerKey(key);
          // Also backfills secrets stored by a build from before the markers existed.
          if ((await markers.getKv(marker)) === undefined) await markers.setKv(marker, true);
          marked.add(key);
        });

  return {
    get: async (key) => {
      const value = await store.get(key);
      if (value !== null) {
        await ensureMarker(key);
        return value;
      }
      marked.delete(key);
      await quietly(async () => {
        const marker = secureStoredMarkerKey(key);
        if ((await markers.getKv(marker)) === undefined) return;
        // Cleared first, so this loss is reported once, not on every later read.
        await markers.deleteKv(marker);
        await options.onSecretsLost();
      });
      return null;
    },
    set: async (key, value) => {
      await store.set(key, value);
      await ensureMarker(key);
    },
    remove: async (key) => {
      marked.delete(key);
      // The marker goes first: if the Keychain delete then fails, the item is still there and the
      // next read writes the marker again, so a deliberate delete is never reported as a loss.
      await quietly(() => markers.deleteKv(secureStoredMarkerKey(key)));
      await store.remove(key);
    },
    removeLegacyPreference: (entry) => store.removeLegacyPreference(entry),
  };
}

/**
 * Boot wiring: iOS gets the marker-based loss detection; Android already reports a lost Keystore
 * key from its plugin, so its store is returned unchanged.
 */
export function withSecretLossDetection(
  platform: MobilePlatform,
  options: Parameters<typeof trackStoredSecrets>[0],
): NativeSecureStorage {
  return platform === 'ios' ? trackStoredSecrets(options) : options.store;
}
