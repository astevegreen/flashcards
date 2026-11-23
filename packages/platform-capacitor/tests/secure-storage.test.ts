import { describe, expect, it, vi } from 'vitest';
import { createHlcState } from '../../core/src/index.ts';
import { NativeMicrosoftAuth } from '../../platform-web/src/auth/microsoft-native-auth.ts';
import { TTS_CONFIG_KV_KEY as UI_TTS_CONFIG_KV_KEY } from '../../ui/src/state/useAudioController.ts';
import { createGoogleSignIn, type GoogleSocialLoginPort } from '../src/auth/google-social-login.ts';
import {
  createSecureMicrosoftBridge,
  migrateMicrosoftRefreshToken,
  type MicrosoftOAuth2LoginResult,
  type MicrosoftSocialLoginPort,
  type MicrosoftTokenPost,
} from '../src/auth/microsoft-secure-bridge.ts';
import {
  CapacitorSqliteStorage,
  createCapacitorPlatform,
  InMemorySqliteDriver,
  type SqliteDriver,
} from '../src/index.ts';
import { assertNativeOAuthRedirect, isAppDeepLink } from '../src/native/deep-links.ts';
import { CAPACITOR_GOOGLE_SESSION_KV_KEY } from '../src/auth/native-google-auth.ts';
import { createSecureKvRouting, SECURE_KV_MIGRATED_KEY } from '../src/secure/secure-kv-storage.ts';
import {
  clearPluginTokenCopiesAtLaunch,
  googleSignInCleanup,
  prepareSecureStorageAtLaunch,
} from '../src/secure/secure-launch.ts';
import {
  MICROSOFT_REFRESH_TOKEN_KEY,
  ONEDRIVE_SESSION_KV_KEY,
  SECURE_KV_KEYS,
  SOCIAL_LOGIN_GOOGLE_ANDROID_COPY,
  TTS_CONFIG_KV_KEY,
  type LegacyPreferenceEntry,
  type NativeSecureStorage,
} from '../src/secure/secure-store.ts';
import { FlashSecureStorageWeb } from '../../capacitor-secure-storage/src/web.ts';

/** In-memory stand-in for the Keychain / Keystore plugin. */
class FakeSecureStorage implements NativeSecureStorage {
  readonly values = new Map<string, string>();
  readonly legacyRemoved: LegacyPreferenceEntry[] = [];
  failWrites = false;
  getCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    if (this.failWrites) throw new Error('Keystore unavailable');
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  async removeLegacyPreference(entry: LegacyPreferenceEntry): Promise<void> {
    this.legacyRemoved.push(entry);
  }
}

/** Records every SQL parameter so a test can prove a secret never reached SQLite. */
class RecordingDriver implements SqliteDriver {
  private readonly inner = new InMemorySqliteDriver();
  readonly written: string[] = [];

  async execute(sql: string, params?: readonly unknown[]): Promise<void> {
    this.written.push(JSON.stringify(params ?? []));
    await this.inner.execute(sql, params);
  }

  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    return this.inner.query<T>(sql, params);
  }

  mentions(secret: string): boolean {
    return this.written.some((p) => p.includes(secret));
  }
}

/** The sign-in plugin with its plaintext token store. */
class FakeSocialLogin implements MicrosoftSocialLoginPort {
  stored: { refreshToken?: string } | null = null;
  clearCalls = 0;
  failClear = false;
  nextLogin: MicrosoftOAuth2LoginResult = {
    accessToken: { token: 'access-1', expires: new Date(Date.now() + 3600_000).toISOString() },
    refreshToken: 'refresh-1',
    expiresIn: 3600,
  };
  readonly loginScopes: string[][] = [];

  async login(scopes: readonly string[]): Promise<MicrosoftOAuth2LoginResult> {
    this.loginScopes.push([...scopes]);
    // Mirrors the plugin: every successful login is persisted in plaintext.
    const refreshToken = this.nextLogin.refreshToken ?? undefined;
    this.stored = refreshToken ? { refreshToken } : {};
    return this.nextLogin;
  }

  async readStoredTokens(): Promise<{ refreshToken?: string } | null> {
    return this.stored;
  }

  async clearStoredTokens(): Promise<void> {
    this.clearCalls += 1;
    if (this.failClear) throw new Error('plugin busy');
    this.stored = null;
  }
}

function tokenEndpoint(
  respond: (form: Readonly<Record<string, string>>) => { status: number; data: unknown },
): MicrosoftTokenPost & { forms: Array<Readonly<Record<string, string>>> } {
  const forms: Array<Readonly<Record<string, string>>> = [];
  const post = async (form: Readonly<Record<string, string>>) => {
    forms.push(form);
    return respond(form);
  };
  return Object.assign(post, { forms });
}

/** SQLite storage that records which KV keys reach it, so a test can prove a key was routed away. */
class KvKeyRecordingStorage extends CapacitorSqliteStorage {
  readonly kvKeysWritten: string[] = [];

  override async setKv(key: string, value: unknown): Promise<void> {
    this.kvKeysWritten.push(key);
    await super.setKv(key, value);
  }
}

function setup() {
  const driver = new RecordingDriver();
  const database = new KvKeyRecordingStorage(driver);
  const secure = new FakeSecureStorage();
  const routing = createSecureKvRouting({
    inner: database,
    secureStore: secure,
    kvKeys: SECURE_KV_KEYS,
    extraSecretKeys: [MICROSOFT_REFRESH_TOKEN_KEY],
  });
  return { driver, database, secure, routing };
}

describe('secure KV routing (§16: tokens only in Keychain/Keystore)', () => {
  it('keeps routed keys in the secure store and everything else in SQLite', async () => {
    const { driver, database, secure, routing } = setup();
    await routing.storage.setKv('capacitor_google_session_v1', { accessToken: 'ya29.secret' });
    await routing.storage.setKv('onboarding_v1', { done: true });

    expect(await routing.storage.getKv('capacitor_google_session_v1')).toEqual({
      accessToken: 'ya29.secret',
    });
    expect(await database.getKv('capacitor_google_session_v1')).toBeUndefined();
    expect(driver.mentions('ya29.secret')).toBe(false);
    expect(secure.values.get('kv.capacitor_google_session_v1')).toContain('ya29.secret');
    expect(await database.getKv('onboarding_v1')).toEqual({ done: true });

    await routing.storage.deleteKv('capacitor_google_session_v1');
    expect(await routing.storage.getKv('capacitor_google_session_v1')).toBeUndefined();
    expect(secure.values.has('kv.capacitor_google_session_v1')).toBe(false);
  });

  it('moves a row an older build left in SQLite on first read, then deletes it', async () => {
    const { database, secure, routing } = setup();
    await database.setKv('onedrive_native_session_v1', { accessToken: 'old', scope: 'x' });

    expect(await routing.storage.getKv('onedrive_native_session_v1')).toEqual({
      accessToken: 'old',
      scope: 'x',
    });
    expect(await database.getKv('onedrive_native_session_v1')).toBeUndefined();
    expect(JSON.parse(secure.values.get('kv.onedrive_native_session_v1') ?? 'null')).toEqual({
      accessToken: 'old',
      scope: 'x',
    });
  });

  it('migrates every legacy row at launch; a secure copy wins over a stale row', async () => {
    const { database, secure, routing } = setup();
    await database.setDeviceMeta({ deviceId: 'd', seq: 0, hlc: createHlcState('d', 0) });
    await database.setKv('tts_config_v1', { apiKey: 'tts-key' });
    await database.setKv('capacitor_google_session_v1', { accessToken: 'stale' });
    secure.values.set('kv.capacitor_google_session_v1', JSON.stringify({ accessToken: 'fresh' }));

    await prepareSecureStorageAtLaunch({ database, routing });

    expect(await database.getKv('tts_config_v1')).toBeUndefined();
    expect(await database.getKv('capacitor_google_session_v1')).toBeUndefined();
    expect(await routing.storage.getKv('tts_config_v1')).toEqual({ apiKey: 'tts-key' });
    expect(await routing.storage.getKv('capacitor_google_session_v1')).toEqual({
      accessToken: 'fresh',
    });
  });

  it('scrubs free pages once, right after the first migration sweep', async () => {
    const { driver, database, routing } = setup();
    const execute = vi.spyOn(driver, 'execute');
    const scrubFreePages = vi.fn(() => database.scrubFreePages());

    // A fresh database has nothing to scrub.
    await prepareSecureStorageAtLaunch({ database, routing, scrubFreePages });
    expect(scrubFreePages).not.toHaveBeenCalled();

    await database.setDeviceMeta({ deviceId: 'd', seq: 0, hlc: createHlcState('d', 0) });
    await database.setKv('tts_config_v1', { apiKey: 'tts-key' });
    await prepareSecureStorageAtLaunch({ database, routing, scrubFreePages });
    expect(scrubFreePages).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('VACUUM');

    // Later launches skip the sweep, so they never rebuild the file again.
    await prepareSecureStorageAtLaunch({ database, routing, scrubFreePages });
    expect(scrubFreePages).toHaveBeenCalledTimes(1);
  });

  it('wipes secrets left by an earlier install when the database is fresh', async () => {
    const { database, secure, routing } = setup();
    secure.values.set(MICROSOFT_REFRESH_TOKEN_KEY, 'from-previous-install');
    secure.values.set('kv.onedrive_native_session_v1', '{"accessToken":"a"}');
    secure.values.set('unrelated', 'kept');

    await prepareSecureStorageAtLaunch({ database, routing });

    expect([...secure.values.keys()]).toEqual(['unrelated']);
  });

  it('clearAll (Reset Local Device Data) also deletes the secrets', async () => {
    const { secure, routing } = setup();
    await routing.storage.setKv('onedrive_native_session_v1', { accessToken: 'a' });
    secure.values.set(MICROSOFT_REFRESH_TOKEN_KEY, 'r');

    await routing.storage.clearAll();

    expect(secure.values.size).toBe(0);
  });

  it('never falls back to SQLite when the secure store fails', async () => {
    const { driver, database, secure, routing } = setup();
    secure.failWrites = true;
    await expect(
      routing.storage.setKv('capacitor_google_session_v1', { accessToken: 'ya29.nope' }),
    ).rejects.toThrow('Keystore unavailable');
    expect(await database.getKv('capacitor_google_session_v1')).toBeUndefined();
    expect(driver.mentions('ya29.nope')).toBe(false);
  });

  it('runs the launch sweep once per database; getKv still moves later stragglers', async () => {
    const { database, secure, routing } = setup();
    await database.setDeviceMeta({ deviceId: 'd', seq: 0, hlc: createHlcState('d', 0) });
    await routing.migrateLegacyRows();
    expect(await database.getKv(SECURE_KV_MIGRATED_KEY)).toBe(true);

    // A row written after the sweep (e.g. by a downgraded build) is not swept again at launch…
    await database.setKv(TTS_CONFIG_KV_KEY, { apiKey: 'late' });
    const callsBefore = secure.getCalls;
    await prepareSecureStorageAtLaunch({ database, routing });
    expect(secure.getCalls).toBe(callsBefore);
    expect(await database.getKv(TTS_CONFIG_KV_KEY)).toEqual({ apiKey: 'late' });

    // …but the first read still moves it.
    expect(await routing.storage.getKv(TTS_CONFIG_KV_KEY)).toEqual({ apiKey: 'late' });
    expect(await database.getKv(TTS_CONFIG_KV_KEY)).toBeUndefined();
    expect(secure.values.get(`kv.${TTS_CONFIG_KV_KEY}`)).toContain('late');
  });

  it('caches decrypted values for the session and forgets them on delete', async () => {
    const { secure, routing } = setup();
    await routing.storage.setKv(TTS_CONFIG_KV_KEY, { apiKey: 'k1' });
    const callsBefore = secure.getCalls;
    expect(await routing.storage.getKv(TTS_CONFIG_KV_KEY)).toEqual({ apiKey: 'k1' });
    expect(await routing.storage.getKv(TTS_CONFIG_KV_KEY)).toEqual({ apiKey: 'k1' });
    expect(secure.getCalls).toBe(callsBefore);

    await routing.storage.deleteKv(TTS_CONFIG_KV_KEY);
    expect(await routing.storage.getKv(TTS_CONFIG_KV_KEY)).toBeUndefined();

    await routing.storage.setKv(TTS_CONFIG_KV_KEY, { apiKey: 'k2' });
    await routing.removeSecrets();
    expect(await routing.storage.getKv(TTS_CONFIG_KV_KEY)).toBeUndefined();
  });

  it('a failed secure write leaves no cached value behind', async () => {
    const { secure, routing } = setup();
    await routing.storage.setKv(TTS_CONFIG_KV_KEY, { apiKey: 'old' });
    secure.failWrites = true;
    await expect(routing.storage.setKv(TTS_CONFIG_KV_KEY, { apiKey: 'new' })).rejects.toThrow();
    expect(await routing.storage.getKv(TTS_CONFIG_KV_KEY)).toEqual({ apiKey: 'old' });
  });

  it('SECURE_KV_KEYS names the real key constants of every secret-holding adapter', async () => {
    expect(SECURE_KV_KEYS).toContain(CAPACITOR_GOOGLE_SESSION_KV_KEY);
    expect(SECURE_KV_KEYS).toContain(UI_TTS_CONFIG_KV_KEY);
    expect(TTS_CONFIG_KV_KEY).toBe(UI_TTS_CONFIG_KV_KEY);
    expect(SECURE_KV_KEYS).toContain(ONEDRIVE_SESSION_KV_KEY);

    // Also prove behaviourally that whatever key `NativeMicrosoftAuth` and `CapacitorGoogleAuth`
    // write is routed: neither may write any KV row to SQLite.
    const { database, secure, routing } = setup();
    const now = 1_000_000;
    const microsoft = new NativeMicrosoftAuth({
      bridge: createSecureMicrosoftBridge({
        clientId: 'c',
        socialLogin: new FakeSocialLogin(),
        secureStore: secure,
        postToken: tokenEndpoint(() => ({ status: 500, data: {} })),
        nowMs: () => now,
      }),
      storage: routing.storage,
      nowMs: () => now,
    });
    await microsoft.signIn();
    const google = await createCapacitorPlatform({
      deviceId: 'cap-test',
      storage: routing.storage,
      googleSignInPlugin: {
        signIn: async () => ({ accessToken: 'ya29.google', expiresInSeconds: 3600 }),
        refreshToken: async () => ({ accessToken: 'ya29.google2', expiresInSeconds: 3600 }),
        signOut: async () => undefined,
      },
    }).getGoogleAuth();
    await google.signIn();

    expect(database.kvKeysWritten).toEqual([]);
    expect(secure.values.has(`kv.${ONEDRIVE_SESSION_KV_KEY}`)).toBe(true);
    expect(secure.values.has(`kv.${CAPACITOR_GOOGLE_SESSION_KV_KEY}`)).toBe(true);
  });

  it('createCapacitorPlatform: the Google access token never reaches SQLite', async () => {
    const { driver, routing } = setup();
    const platform = createCapacitorPlatform({
      deviceId: 'cap-test',
      storage: routing.storage,
      googleSignInPlugin: {
        signIn: async () => ({ accessToken: 'ya29.google', expiresInSeconds: 3600 }),
        refreshToken: async () => ({ accessToken: 'ya29.google2', expiresInSeconds: 3600 }),
        signOut: async () => undefined,
      },
    });
    const auth = await platform.getGoogleAuth();
    await auth.signIn();
    expect(await auth.getValidAccessToken({ forceRefresh: true })).toBe('ya29.google2');
    expect(driver.mentions('ya29.google')).toBe(false);
    expect(platform.storage).toBe(routing.storage);
  });
});

describe('Microsoft refresh token lives only in the secure store', () => {
  it('moves the token after sign-in and clears the plugin copy', async () => {
    const secure = new FakeSecureStorage();
    const socialLogin = new FakeSocialLogin();
    const bridge = createSecureMicrosoftBridge({
      clientId: 'client-1',
      socialLogin,
      secureStore: secure,
      postToken: tokenEndpoint(() => ({ status: 500, data: {} })),
    });

    const tokens = await bridge.authorize(['Files.ReadWrite.AppFolder', 'offline_access']);

    expect(tokens.accessToken).toBe('access-1');
    expect(secure.values.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBe('refresh-1');
    expect(socialLogin.stored).toBeNull();
    expect(socialLogin.clearCalls).toBe(1);
  });

  it('reads the refresh token nested in accessToken when the top-level one is missing', async () => {
    const secure = new FakeSecureStorage();
    const socialLogin = new FakeSocialLogin();
    socialLogin.nextLogin = {
      accessToken: { token: 'a', refreshToken: 'nested-refresh' },
      refreshToken: null,
      expiresIn: 3600,
    };
    const bridge = createSecureMicrosoftBridge({
      clientId: 'c',
      socialLogin,
      secureStore: secure,
      postToken: tokenEndpoint(() => ({ status: 500, data: {} })),
    });
    await bridge.authorize(['offline_access']);
    expect(secure.values.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBe('nested-refresh');
  });

  it('a sign-in that returns no refresh token forgets the old one (it may be another account)', async () => {
    const secure = new FakeSecureStorage();
    await secure.set(MICROSOFT_REFRESH_TOKEN_KEY, 'old-account-refresh');
    const socialLogin = new FakeSocialLogin();
    socialLogin.nextLogin = { accessToken: { token: 'a' }, refreshToken: null, expiresIn: 3600 };
    const bridge = createSecureMicrosoftBridge({
      clientId: 'c',
      socialLogin,
      secureStore: secure,
      postToken: tokenEndpoint(() => ({ status: 500, data: {} })),
    });
    const tokens = await bridge.authorize(['offline_access']);
    expect(tokens.accessToken).toBe('a');
    expect(secure.values.has(MICROSOFT_REFRESH_TOKEN_KEY)).toBe(false);
    await expect(bridge.refresh(['offline_access'])).rejects.toThrow('Not signed in');
  });

  it('still clears the plugin copy when the secure write fails', async () => {
    const secure = new FakeSecureStorage();
    secure.failWrites = true;
    const socialLogin = new FakeSocialLogin();
    const bridge = createSecureMicrosoftBridge({
      clientId: 'c',
      socialLogin,
      secureStore: secure,
      postToken: tokenEndpoint(() => ({ status: 500, data: {} })),
    });
    await expect(bridge.authorize(['offline_access'])).rejects.toThrow('Keystore unavailable');
    expect(socialLogin.stored).toBeNull();
  });

  it('a failed plugin clean-up does not fail sign-in (next launch retries it)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const secure = new FakeSecureStorage();
    const socialLogin = new FakeSocialLogin();
    socialLogin.failClear = true;
    const bridge = createSecureMicrosoftBridge({
      clientId: 'c',
      socialLogin,
      secureStore: secure,
      postToken: tokenEndpoint(() => ({ status: 500, data: {} })),
    });
    await expect(bridge.authorize(['offline_access'])).resolves.toMatchObject({
      accessToken: 'access-1',
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    socialLogin.failClear = false;
    expect(await migrateMicrosoftRefreshToken({ socialLogin, secureStore: secure })).toBe(true);
    expect(socialLogin.stored).toBeNull();
  });

  it('refreshes over the token endpoint with the secure token and stores the rotated one', async () => {
    const secure = new FakeSecureStorage();
    secure.values.set(MICROSOFT_REFRESH_TOKEN_KEY, 'refresh-1');
    const post = tokenEndpoint(() => ({
      status: 200,
      // CapacitorHttp may hand back a string when the content type is not recognised.
      data: JSON.stringify({
        access_token: 'access-2',
        expires_in: 3599,
        refresh_token: 'refresh-2',
      }),
    }));
    const socialLogin = new FakeSocialLogin();
    const bridge = createSecureMicrosoftBridge({
      clientId: 'client-1',
      socialLogin,
      secureStore: secure,
      postToken: post,
    });

    const tokens = await bridge.refresh(['Files.ReadWrite.AppFolder', 'offline_access']);

    expect(tokens).toEqual({ accessToken: 'access-2', expiresInSeconds: 3599 });
    expect(post.forms).toEqual([
      {
        client_id: 'client-1',
        grant_type: 'refresh_token',
        refresh_token: 'refresh-1',
        scope: 'Files.ReadWrite.AppFolder offline_access',
      },
    ]);
    expect(secure.values.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBe('refresh-2');
    // The plugin is never involved in a refresh, so it never re-persists tokens.
    expect(socialLogin.stored).toBeNull();
  });

  it('maps invalid_grant to a rejection, and throttling or outages to retryable errors', async () => {
    const secure = new FakeSecureStorage();
    secure.values.set(MICROSOFT_REFRESH_TOKEN_KEY, 'refresh-1');
    const make = (status: number, data: unknown) =>
      createSecureMicrosoftBridge({
        clientId: 'c',
        socialLogin: new FakeSocialLogin(),
        secureStore: secure,
        postToken: tokenEndpoint(() => ({ status, data })),
      });

    await expect(
      make(400, { error: 'invalid_grant', error_description: 'AADSTS70008: expired' }).refresh([]),
    ).rejects.toMatchObject({ name: 'MicrosoftRefreshRejectedError' });
    await expect(make(429, { error: 'throttled' }).refresh([])).rejects.not.toMatchObject({
      name: 'MicrosoftRefreshRejectedError',
    });
    await expect(make(503, {}).refresh([])).rejects.toThrow('returned 503');
    expect(secure.values.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBe('refresh-1');
  });

  it('refresh without a stored token asks for a new sign-in', async () => {
    const bridge = createSecureMicrosoftBridge({
      clientId: 'c',
      socialLogin: new FakeSocialLogin(),
      secureStore: new FakeSecureStorage(),
      postToken: tokenEndpoint(() => ({ status: 200, data: { access_token: 'x' } })),
    });
    await expect(bridge.refresh([])).rejects.toMatchObject({
      name: 'MicrosoftRefreshRejectedError',
    });
  });

  it('sign-out removes the secure token and any plugin copy', async () => {
    const secure = new FakeSecureStorage();
    secure.values.set(MICROSOFT_REFRESH_TOKEN_KEY, 'refresh-1');
    const socialLogin = new FakeSocialLogin();
    socialLogin.stored = { refreshToken: 'leftover' };
    const bridge = createSecureMicrosoftBridge({
      clientId: 'c',
      socialLogin,
      secureStore: secure,
      postToken: tokenEndpoint(() => ({ status: 500, data: {} })),
    });
    await bridge.signOut();
    expect(secure.values.has(MICROSOFT_REFRESH_TOKEN_KEY)).toBe(false);
    expect(socialLogin.stored).toBeNull();
  });

  it('migration moves a plaintext token, prefers the secure copy, and no-ops when empty', async () => {
    const secure = new FakeSecureStorage();
    const socialLogin = new FakeSocialLogin();

    expect(await migrateMicrosoftRefreshToken({ socialLogin, secureStore: secure })).toBe(false);
    expect(socialLogin.clearCalls).toBe(0);

    socialLogin.stored = { refreshToken: 'legacy' };
    expect(await migrateMicrosoftRefreshToken({ socialLogin, secureStore: secure })).toBe(true);
    expect(secure.values.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBe('legacy');
    expect(socialLogin.stored).toBeNull();

    socialLogin.stored = { refreshToken: 'older' };
    await migrateMicrosoftRefreshToken({ socialLogin, secureStore: secure });
    expect(secure.values.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBe('legacy');
    expect(socialLogin.stored).toBeNull();
  });

  it('migration keeps the plaintext copy when the secure write fails', async () => {
    const secure = new FakeSecureStorage();
    secure.failWrites = true;
    const socialLogin = new FakeSocialLogin();
    socialLogin.stored = { refreshToken: 'legacy' };
    await expect(
      migrateMicrosoftRefreshToken({ socialLogin, secureStore: secure }),
    ).rejects.toThrow();
    expect(socialLogin.stored).toEqual({ refreshToken: 'legacy' });
  });

  it('a failed plugin clean-up during migration does not block OneDrive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const secure = new FakeSecureStorage();
    const socialLogin = new FakeSocialLogin();
    socialLogin.stored = { refreshToken: 'legacy' };
    socialLogin.failClear = true;
    await expect(migrateMicrosoftRefreshToken({ socialLogin, secureStore: secure })).resolves.toBe(
      true,
    );
    expect(secure.values.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBe('legacy');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('end to end with NativeMicrosoftAuth: no token reaches SQLite; sign-out clears it', async () => {
    const { driver, secure, routing } = setup();
    const socialLogin = new FakeSocialLogin();
    let now = 1_000_000;
    const bridge = createSecureMicrosoftBridge({
      clientId: 'c',
      socialLogin,
      secureStore: secure,
      postToken: tokenEndpoint(() => ({
        status: 200,
        data: { access_token: 'access-2', expires_in: 3600, refresh_token: 'refresh-2' },
      })),
      nowMs: () => now,
    });
    const auth = new NativeMicrosoftAuth({ bridge, storage: routing.storage, nowMs: () => now });

    await auth.signIn();
    expect(await auth.isConnected()).toBe(true);
    now += 3600_000;
    expect(await auth.getValidAccessToken()).toBe('access-2');

    for (const secret of ['access-1', 'access-2', 'refresh-1', 'refresh-2']) {
      expect(driver.mentions(secret)).toBe(false);
    }
    expect(secure.values.get(MICROSOFT_REFRESH_TOKEN_KEY)).toBe('refresh-2');
    expect(socialLogin.stored).toBeNull();

    await auth.signOut();
    expect(await auth.isConnected()).toBe(false);
    expect(secure.values.size).toBe(0);
  });
});

describe('launch clean-up of the sign-in plugin’s plaintext copies', () => {
  it('Android, OneDrive not connected: deletes the Google and Microsoft copies directly', async () => {
    const { secure, routing } = setup();
    const loadOneDrive = vi.fn(async () => undefined);
    await clearPluginTokenCopiesAtLaunch({
      platform: 'android',
      secureStorage: secure,
      storage: routing.storage,
      loadOneDrive,
    });
    expect(loadOneDrive).not.toHaveBeenCalled();
    expect(secure.legacyRemoved).toEqual([
      {
        androidPreferencesName: 'GOOGLE_LOGIN_F13oz0I_SHARED_PERF',
        key: 'GOOGLE_LOGIN_GOOGLE_DATA_9158025e-947d-4211-ba51-40451630cc47',
      },
      { androidPreferencesName: 'CapgoOAuth2ProviderPrefs', key: 'OAuth2Tokens_microsoft' },
    ]);
  });

  it('iOS, OneDrive connected: starts the bridge (which migrates) instead of deleting', async () => {
    const { secure, routing } = setup();
    await routing.storage.setKv('onedrive_native_session_v1', { accessToken: 'a', scope: '' });
    const loadOneDrive = vi.fn(async () => undefined);
    await clearPluginTokenCopiesAtLaunch({
      platform: 'ios',
      secureStorage: secure,
      storage: routing.storage,
      loadOneDrive,
    });
    expect(loadOneDrive).toHaveBeenCalledTimes(1);
    expect(secure.legacyRemoved).toEqual([]);
  });

  it('iOS, no Microsoft client in this build: deletes the UserDefaults copy', async () => {
    const { secure, routing } = setup();
    await clearPluginTokenCopiesAtLaunch({
      platform: 'ios',
      secureStorage: secure,
      storage: routing.storage,
    });
    expect(secure.legacyRemoved).toEqual([{ key: 'CapgoOAuth2ProviderTokens_microsoft' }]);
  });
});

describe('deep-link and redirect URL validation', () => {
  it('accepts only flashcards://oauth/<provider> as the native OAuth redirect', () => {
    expect(assertNativeOAuthRedirect('flashcards://oauth/microsoft')).toBe(
      'flashcards://oauth/microsoft',
    );
    for (const bad of [
      'https://login.microsoftonline.com/oauth/microsoft',
      'flashcards://picker-callback/microsoft',
      'flashcards://oauth.evil/microsoft',
      'flashcards://oauth/',
      'flashcards://oauth/microsoft?state=x',
      'flashcards://oauth/microsoft#x',
      'flashcards://oauth/ms/extra',
      'not a url',
    ]) {
      expect(() => assertNativeOAuthRedirect(bad), bad).toThrow('Native OAuth redirect');
    }
  });

  it('the picker callback listener ignores the OAuth redirect and look-alike hosts', () => {
    expect(
      isAppDeepLink('flashcards://picker-callback?files=%5B%5D', 'flashcards', 'picker-callback'),
    ).toBe(true);
    expect(isAppDeepLink('FLASHCARDS://picker-callback', 'flashcards', 'picker-callback')).toBe(
      true,
    );
    expect(
      isAppDeepLink('flashcards://oauth/microsoft?code=1&state=2', 'flashcards', 'picker-callback'),
    ).toBe(false);
    expect(
      isAppDeepLink('flashcards://picker-callback.evil/x', 'flashcards', 'picker-callback'),
    ).toBe(false);
    expect(isAppDeepLink('https://picker-callback/x', 'flashcards', 'picker-callback')).toBe(false);
    expect(isAppDeepLink('::', 'flashcards', 'picker-callback')).toBe(false);
  });
});

describe('deep links on Android WebViews older than Chromium 130', () => {
  /** Mimics the old non-standard parse: empty host, authority left in the path. */
  class PreM130Url {
    readonly protocol: string;
    readonly host = '';
    readonly hostname = '';
    readonly pathname: string;
    readonly search = '';
    readonly hash = '';

    constructor(url: string) {
      const colon = url.indexOf(':');
      if (colon <= 0) throw new TypeError('Invalid URL');
      this.protocol = url.slice(0, colon + 1).toLowerCase();
      this.pathname = url.slice(colon + 1);
    }
  }

  it('matches the picker callback and accepts the OneDrive redirect without URL parsing', () => {
    vi.stubGlobal('URL', PreM130Url);
    try {
      expect(new URL('flashcards://picker-callback?x=1').host).toBe('');
      expect(
        isAppDeepLink('flashcards://picker-callback?files=%5B%5D', 'flashcards', 'picker-callback'),
      ).toBe(true);
      expect(isAppDeepLink('flashcards://picker-callback', 'flashcards', 'picker-callback')).toBe(
        true,
      );
      expect(isAppDeepLink('flashcards://picker-callback#x', 'flashcards', 'picker-callback')).toBe(
        true,
      );
      expect(isAppDeepLink('flashcards://picker-callbackx', 'flashcards', 'picker-callback')).toBe(
        false,
      );
      expect(assertNativeOAuthRedirect('flashcards://oauth/microsoft')).toBe(
        'flashcards://oauth/microsoft',
      );
      expect(() => assertNativeOAuthRedirect('flashcards://oauth/Microsoft')).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('native Google sign-in clears the plugin’s Android token copy', () => {
  function fakeGooglePort(overrides: Partial<GoogleSocialLoginPort> = {}) {
    const calls: string[] = [];
    const port: GoogleSocialLoginPort = {
      login: async ({ silent }) => {
        calls.push(silent ? 'login:silent' : 'login');
        return {
          responseType: 'online',
          accessToken: { token: 'ya29.x', expires: new Date(1_000_000 + 1800_000).toISOString() },
          profile: { email: 'me@example.com' },
        };
      },
      logout: async () => {
        calls.push('logout');
      },
      ...overrides,
    };
    return { port, calls };
  }

  it('runs afterLogin after every successful sign-in, silent or not', async () => {
    const { port, calls } = fakeGooglePort();
    const plugin = createGoogleSignIn(port, {
      afterLogin: async () => {
        calls.push('afterLogin');
      },
      nowMs: () => 1_000_000,
    });
    await expect(plugin.signIn({ scopes: ['a', 'b'] })).resolves.toEqual({
      accessToken: 'ya29.x',
      expiresInSeconds: 1800,
      scope: 'a b',
      email: 'me@example.com',
    });
    await plugin.refreshToken();
    await plugin.signOut();
    expect(calls).toEqual(['login', 'afterLogin', 'login:silent', 'afterLogin', 'logout']);
  });

  it('a failing afterLogin never fails sign-in; a failed login skips it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const afterLogin = vi.fn(async () => {
      throw new Error('prefs busy');
    });
    const ok = createGoogleSignIn(fakeGooglePort().port, { afterLogin });
    await expect(ok.signIn({ scopes: ['a'] })).resolves.toMatchObject({ accessToken: 'ya29.x' });
    expect(afterLogin).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    const failing = createGoogleSignIn(
      fakeGooglePort({
        login: async () => {
          throw new Error('cancelled');
        },
      }).port,
      { afterLogin },
    );
    await expect(failing.signIn({ scopes: ['a'] })).rejects.toThrow('cancelled');
    expect(afterLogin).toHaveBeenCalledTimes(1);
  });

  it('rejects a response without an access token (after clearing the copy)', async () => {
    const afterLogin = vi.fn(async () => undefined);
    const plugin = createGoogleSignIn(
      fakeGooglePort({ login: async () => ({ responseType: 'offline' }) }).port,
      { afterLogin },
    );
    await expect(plugin.signIn({ scopes: ['a'] })).rejects.toThrow(
      'did not return an access token',
    );
    expect(afterLogin).toHaveBeenCalledTimes(1);
  });

  it('boot wiring: Android deletes the GoogleProvider copy after sign-in; iOS needs no hook', async () => {
    const secure = new FakeSecureStorage();
    expect(googleSignInCleanup('ios', secure)).toBeUndefined();
    const hook = googleSignInCleanup('android', secure);
    expect(hook).toBeTypeOf('function');
    await hook?.();
    expect(secure.legacyRemoved).toEqual([SOCIAL_LOGIN_GOOGLE_ANDROID_COPY]);
  });
});

describe('web fallback of @flash/capacitor-secure-storage', () => {
  it('refuses to store secrets in the browser', async () => {
    const web = new FlashSecureStorageWeb();
    await expect(web.get({ key: 'k' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(web.set({ key: 'k', value: 'v' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(web.remove({ key: 'k' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(web.removeLegacyPreference({ key: 'k' })).resolves.toBeUndefined();
  });
});
