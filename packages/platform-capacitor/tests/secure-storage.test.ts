import { describe, expect, it, vi } from 'vitest';
import { createHlcState } from '../../core/src/index.ts';
import { NativeMicrosoftAuth } from '../../platform-web/src/auth/microsoft-native-auth.ts';
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
import { createSecureKvRouting } from '../src/secure/secure-kv-storage.ts';
import {
  clearPluginTokenCopiesAtLaunch,
  prepareSecureStorageAtLaunch,
} from '../src/secure/secure-launch.ts';
import {
  MICROSOFT_REFRESH_TOKEN_KEY,
  SECURE_KV_KEYS,
  type LegacyPreferenceEntry,
  type NativeSecureStorage,
} from '../src/secure/secure-store.ts';
import { FlashSecureStorageWeb } from '../../capacitor-secure-storage/src/web.ts';

/** In-memory stand-in for the Keychain / Keystore plugin. */
class FakeSecureStorage implements NativeSecureStorage {
  readonly values = new Map<string, string>();
  readonly legacyRemoved: LegacyPreferenceEntry[] = [];
  failWrites = false;

  async get(key: string): Promise<string | null> {
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

function setup() {
  const driver = new RecordingDriver();
  const database = new CapacitorSqliteStorage(driver);
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

describe('web fallback of @flash/capacitor-secure-storage', () => {
  it('refuses to store secrets in the browser', async () => {
    const web = new FlashSecureStorageWeb();
    await expect(web.get({ key: 'k' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(web.set({ key: 'k', value: 'v' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(web.remove({ key: 'k' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(web.removeLegacyPreference({ key: 'k' })).resolves.toBeUndefined();
  });
});
