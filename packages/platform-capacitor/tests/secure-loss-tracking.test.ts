import { describe, expect, it, vi } from 'vitest';
import { createHlcState } from '../../core/src/index.ts';
import { CapacitorSqliteStorage, InMemorySqliteDriver } from '../src/index.ts';
import { createSecureKvRouting } from '../src/secure/secure-kv-storage.ts';
import {
  markStoredSecretsAtLaunch,
  prepareSecureStorageAtLaunch,
} from '../src/secure/secure-launch.ts';
import {
  secureStoredMarkerKey,
  trackStoredSecrets,
  withSecretLossDetection,
} from '../src/secure/secure-loss-tracking.ts';
import {
  MICROSOFT_REFRESH_TOKEN_KEY,
  SECURE_KEYS_LOST_KV_KEY,
  SECURE_KV_KEYS,
  type LegacyPreferenceEntry,
  type NativeSecureStorage,
} from '../src/secure/secure-store.ts';

const GOOGLE_SESSION = 'capacitor_google_session_v1';

/** In-memory stand-in for the iOS Keychain plugin (it never reports a loss itself). */
class FakeKeychain implements NativeSecureStorage {
  readonly values = new Map<string, string>();
  failRemoves = false;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    if (this.failRemoves) throw new Error('Keychain busy');
    this.values.delete(key);
  }

  async removeLegacyPreference(_entry: LegacyPreferenceEntry): Promise<void> {}
}

/** One app launch on iOS, wired like `native/boot.ts`. */
function launch(database: CapacitorSqliteStorage, keychain: FakeKeychain) {
  const onSecretsLost = vi.fn(() => database.setKv(SECURE_KEYS_LOST_KV_KEY, { at: 1 }));
  const secure = withSecretLossDetection('ios', {
    store: keychain,
    markers: database,
    onSecretsLost,
  });
  const routing = createSecureKvRouting({
    inner: database,
    secureStore: secure,
    kvKeys: SECURE_KV_KEYS,
    extraSecretKeys: [MICROSOFT_REFRESH_TOKEN_KEY],
  });
  return { secure, routing, onSecretsLost };
}

async function existingDatabase(): Promise<CapacitorSqliteStorage> {
  const database = new CapacitorSqliteStorage(new InMemorySqliteDriver());
  await database.setDeviceMeta({ deviceId: 'd', seq: 0, hlc: createHlcState('d', 0) });
  return database;
}

describe('iOS Keychain loss detection', () => {
  it('reports secrets missing after a restore onto another device, once', async () => {
    const database = await existingDatabase();
    const first = launch(database, new FakeKeychain());
    await first.routing.storage.setKv(GOOGLE_SESSION, { accessToken: 'ya29.secret' });
    await first.secure.set(MICROSOFT_REFRESH_TOKEN_KEY, 'refresh');
    // The marker is a plain flag: the key name only, never the value.
    expect(await database.getKv(secureStoredMarkerKey(`kv.${GOOGLE_SESSION}`))).toBe(true);

    // The database comes back from the backup; the `ThisDeviceOnly` Keychain items do not.
    const restored = launch(database, new FakeKeychain());
    await prepareSecureStorageAtLaunch({ database, routing: restored.routing });

    expect(await restored.routing.storage.getKv(GOOGLE_SESSION)).toBeUndefined();
    expect(await restored.secure.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBeNull();
    expect(restored.onSecretsLost).toHaveBeenCalled();
    expect(await database.getKv(SECURE_KEYS_LOST_KV_KEY)).toBeDefined();

    // The markers are cleared, so the same loss is not reported on every later read or launch.
    const callsAfterLoss = restored.onSecretsLost.mock.calls.length;
    expect(await restored.secure.get(`kv.${GOOGLE_SESSION}`)).toBeNull();
    expect(await restored.secure.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBeNull();
    expect(restored.onSecretsLost).toHaveBeenCalledTimes(callsAfterLoss);
    const later = launch(database, new FakeKeychain());
    expect(await later.routing.storage.getKv(GOOGLE_SESSION)).toBeUndefined();
    expect(later.onSecretsLost).not.toHaveBeenCalled();
  });

  it('stays silent on the fresh-install wipe of Keychain items an earlier install left', async () => {
    const database = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const keychain = new FakeKeychain();
    keychain.values.set(`kv.${GOOGLE_SESSION}`, '{"accessToken":"old"}');
    keychain.values.set(MICROSOFT_REFRESH_TOKEN_KEY, 'old-refresh');

    const { routing, onSecretsLost } = launch(database, keychain);
    await prepareSecureStorageAtLaunch({ database, routing });

    expect(keychain.values.size).toBe(0);
    expect(await routing.storage.getKv(GOOGLE_SESSION)).toBeUndefined();
    expect(onSecretsLost).not.toHaveBeenCalled();
    expect(await database.getKv(SECURE_KEYS_LOST_KV_KEY)).toBeUndefined();
  });

  it('stays silent for a key never stored, a sign-out, and Reset Local Device Data', async () => {
    const database = await existingDatabase();
    const { routing, onSecretsLost } = launch(database, new FakeKeychain());
    expect(await routing.storage.getKv(GOOGLE_SESSION)).toBeUndefined();

    await routing.storage.setKv(GOOGLE_SESSION, { accessToken: 'a' });
    await routing.storage.deleteKv(GOOGLE_SESSION);
    expect(await routing.storage.getKv(GOOGLE_SESSION)).toBeUndefined();

    await routing.storage.setKv(GOOGLE_SESSION, { accessToken: 'b' });
    await routing.storage.clearAll();
    await database.setDeviceMeta({ deviceId: 'd', seq: 0, hlc: createHlcState('d', 0) });
    const next = launch(database, new FakeKeychain());
    expect(await next.routing.storage.getKv(GOOGLE_SESSION)).toBeUndefined();

    expect(onSecretsLost).not.toHaveBeenCalled();
    expect(next.onSecretsLost).not.toHaveBeenCalled();
  });

  it('a failed Keychain delete is not later reported as a loss', async () => {
    const database = await existingDatabase();
    const keychain = new FakeKeychain();
    const { secure, onSecretsLost } = launch(database, keychain);
    await secure.set('k', 'v');
    keychain.failRemoves = true;
    await expect(secure.remove('k')).rejects.toThrow('Keychain busy');

    // The item is still there; the next read marks it again, and a later loss is still caught.
    expect(await secure.get('k')).toBe('v');
    expect(await database.getKv(secureStoredMarkerKey('k'))).toBe(true);
    keychain.values.delete('k');
    const next = launch(database, keychain);
    expect(await next.secure.get('k')).toBeNull();
    expect(onSecretsLost).not.toHaveBeenCalled();
    expect(next.onSecretsLost).toHaveBeenCalledTimes(1);
  });

  it('backfills markers for secrets stored by a build from before the markers', async () => {
    const database = await existingDatabase();
    const keychain = new FakeKeychain();
    keychain.values.set(MICROSOFT_REFRESH_TOKEN_KEY, 'refresh');

    const first = launch(database, keychain);
    expect(await first.secure.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBe('refresh');
    expect(await database.getKv(secureStoredMarkerKey(MICROSOFT_REFRESH_TOKEN_KEY))).toBe(true);

    const restored = launch(database, new FakeKeychain());
    expect(await restored.secure.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBeNull();
    expect(restored.onSecretsLost).toHaveBeenCalledTimes(1);
  });

  it('marks at launch a secret an older build stored that is never read before the backup', async () => {
    const database = await existingDatabase();
    const keychain = new FakeKeychain();
    // Stored by a build from before the markers; this build never reads either secret.
    keychain.values.set(`kv.${GOOGLE_SESSION}`, '{"accessToken":"old"}');
    keychain.values.set(MICROSOFT_REFRESH_TOKEN_KEY, 'refresh');

    const upgraded = launch(database, keychain);
    await prepareSecureStorageAtLaunch({ database, routing: upgraded.routing });
    await markStoredSecretsAtLaunch({
      platform: 'ios',
      secureStorage: upgraded.secure,
      keys: upgraded.routing.secretKeys,
    });
    expect(await database.getKv(secureStoredMarkerKey(`kv.${GOOGLE_SESSION}`))).toBe(true);
    expect(await database.getKv(secureStoredMarkerKey(MICROSOFT_REFRESH_TOKEN_KEY))).toBe(true);
    // Only names: no marker for a secret that is not there, and no value in any marker.
    for (const key of SECURE_KV_KEYS.filter((k) => k !== GOOGLE_SESSION)) {
      expect(await database.getKv(secureStoredMarkerKey(`kv.${key}`))).toBeUndefined();
    }
    expect(upgraded.onSecretsLost).not.toHaveBeenCalled();

    // Restored onto another device: the loss is explained, at launch.
    const restored = launch(database, new FakeKeychain());
    await prepareSecureStorageAtLaunch({ database, routing: restored.routing });
    await markStoredSecretsAtLaunch({
      platform: 'ios',
      secureStorage: restored.secure,
      keys: restored.routing.secretKeys,
    });
    expect(restored.onSecretsLost).toHaveBeenCalled();
    expect(await database.getKv(SECURE_KEYS_LOST_KV_KEY)).toBeDefined();
  });

  it('the launch marking stays silent on a fresh install and is skipped on Android', async () => {
    const database = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const keychain = new FakeKeychain();
    keychain.values.set(MICROSOFT_REFRESH_TOKEN_KEY, 'left-by-an-earlier-install');
    const fresh = launch(database, keychain);
    await prepareSecureStorageAtLaunch({ database, routing: fresh.routing });
    await markStoredSecretsAtLaunch({
      platform: 'ios',
      secureStorage: fresh.secure,
      keys: fresh.routing.secretKeys,
    });
    expect(keychain.values.size).toBe(0);
    expect(
      await database.getKv(secureStoredMarkerKey(MICROSOFT_REFRESH_TOKEN_KEY)),
    ).toBeUndefined();
    expect(fresh.onSecretsLost).not.toHaveBeenCalled();

    const get = vi.fn(async () => 'v');
    await markStoredSecretsAtLaunch({ platform: 'android', secureStorage: { get }, keys: ['k'] });
    expect(get).not.toHaveBeenCalled();
  });

  it('the launch marking never throws and still marks the keys it can read', async () => {
    const database = await existingDatabase();
    const keychain = new FakeKeychain();
    keychain.values.set('b', 'v');
    const { secure } = launch(database, keychain);
    const flaky = {
      get: (key: string) =>
        key === 'a' ? Promise.reject(new Error('Keychain busy')) : secure.get(key),
    };
    await expect(
      markStoredSecretsAtLaunch({ platform: 'ios', secureStorage: flaky, keys: ['a', 'b'] }),
    ).resolves.toBeUndefined();
    expect(await database.getKv(secureStoredMarkerKey('b'))).toBe(true);
  });

  it('a failing marker store never breaks a secret read or write', async () => {
    const keychain = new FakeKeychain();
    const broken = {
      getKv: vi.fn(async () => {
        throw new Error('disk full');
      }),
      setKv: vi.fn(async () => {
        throw new Error('disk full');
      }),
      deleteKv: vi.fn(async () => {
        throw new Error('disk full');
      }),
    };
    const onSecretsLost = vi.fn();
    const secure = trackStoredSecrets({ store: keychain, markers: broken, onSecretsLost });

    await expect(secure.set('k', 'v')).resolves.toBeUndefined();
    await expect(secure.get('k')).resolves.toBe('v');
    await expect(secure.get('missing')).resolves.toBeNull();
    await expect(secure.remove('k')).resolves.toBeUndefined();
    expect(keychain.values.has('k')).toBe(false);
    expect(onSecretsLost).not.toHaveBeenCalled();
  });

  it('a token refresh racing a sign-out never leaves a marker without its secret', async () => {
    const database = await existingDatabase();
    const keychain = new FakeKeychain();
    // Holds the set's marker write until the sign-out has been started.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;
    const markers = {
      getKv: async <T>(key: string) => {
        if (gated) {
          gated = false;
          await gate;
        }
        return database.getKv<T>(key);
      },
      setKv: (key: string, value: unknown) => database.setKv(key, value),
      deleteKv: (key: string) => database.deleteKv(key),
    };
    const onSecretsLost = vi.fn();
    const secure = trackStoredSecrets({ store: keychain, markers, onSecretsLost });

    const refresh = secure.set('k', 'fresh-token');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const signOut = secure.remove('k');
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([refresh, signOut]);

    expect(keychain.values.has('k')).toBe(false);
    expect(await database.getKv(secureStoredMarkerKey('k'))).toBeUndefined();
    expect(await secure.get('k')).toBeNull();
    expect(onSecretsLost).not.toHaveBeenCalled();
  });

  it('a failed operation does not block later ones on the same key', async () => {
    const database = await existingDatabase();
    const keychain = new FakeKeychain();
    const { secure } = launch(database, keychain);
    keychain.failRemoves = true;
    await expect(secure.remove('k')).rejects.toThrow('Keychain busy');
    keychain.failRemoves = false;
    await secure.set('k', 'v');
    await expect(secure.get('k')).resolves.toBe('v');
  });

  it('reads the marker once per session for a secret that is present', async () => {
    const database = await existingDatabase();
    const getKv = vi.spyOn(database, 'getKv');
    const { secure } = launch(database, new FakeKeychain());
    await secure.set('k', 'v');
    getKv.mockClear();
    await secure.get('k');
    await secure.get('k');
    expect(getKv).not.toHaveBeenCalled();
  });

  it('leaves Android unchanged: its plugin reports a lost Keystore key itself', () => {
    const keychain = new FakeKeychain();
    const database = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const store = withSecretLossDetection('android', {
      store: keychain,
      markers: database,
      onSecretsLost: () => undefined,
    });
    expect(store).toBe(keychain);
  });
});
