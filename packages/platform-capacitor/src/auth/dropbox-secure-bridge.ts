/**
 * Dropbox public-client bridge for Android / iOS that keeps the Dropbox refresh token only in the
 * Keychain / Keystore (§13, §16). Pure and injectable; `native/dropbox-social-login.ts` wires the
 * real plugins.
 *
 * `@capgo/capacitor-social-login` runs the sign-in (authorization code + PKCE in
 * ASWebAuthenticationSession / Custom Tabs), and always writes the tokens it receives to
 * UserDefaults / SharedPreferences. So after every sign-in the refresh token is copied to the
 * secure store and the plugin's copy is deleted. Refreshes call Dropbox's token endpoint directly
 * over native HTTP (`CapacitorHttp`).
 */
import {
  DropboxRefreshRejectedError,
  type DropboxPublicClientBridge,
  type DropboxTokenSet,
} from '@flash/platform-web/dropbox';
import { DROPBOX_REFRESH_TOKEN_KEY, type SecureStore } from '../secure/secure-store.ts';

/** The subset of the plugin's OAuth2 login response this bridge reads. */
export interface DropboxOAuth2LoginResult {
  accessToken: { token: string; expires?: string; refreshToken?: string } | null;
  refreshToken?: string | null;
  expiresIn?: number | null;
}

/** The sign-in plugin, reduced to what this bridge needs. */
export interface DropboxSocialLoginPort {
  login(): Promise<DropboxOAuth2LoginResult>;
  /** The plugin's own persisted copy, or `null` when it holds none. */
  readStoredTokens(): Promise<{ refreshToken?: string } | null>;
  /** Deletes the plugin's persisted copy. */
  clearStoredTokens(): Promise<void>;
}

/** POSTs an `application/x-www-form-urlencoded` body to the Dropbox token endpoint. */
export type DropboxTokenPost = (
  form: Readonly<Record<string, string>>,
) => Promise<{ status: number; data: unknown }>;

interface DropboxTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

function parseTokenResponse(data: unknown): DropboxTokenResponse {
  if (typeof data === 'string') {
    try {
      return parseTokenResponse(JSON.parse(data) as unknown);
    } catch {
      return {};
    }
  }
  return data !== null && typeof data === 'object' ? (data as DropboxTokenResponse) : {};
}

function loginToTokenSet(result: DropboxOAuth2LoginResult, nowMs: number): DropboxTokenSet {
  const token = result.accessToken?.token;
  if (!token) throw new Error('Dropbox sign-in returned no access token.');
  const expiresAt = result.accessToken?.expires
    ? Date.parse(result.accessToken.expires)
    : Number.NaN;
  const fromExpiry = Number.isNaN(expiresAt) ? null : Math.round((expiresAt - nowMs) / 1000);
  return {
    accessToken: token,
    expiresInSeconds: Math.max(60, result.expiresIn ?? fromExpiry ?? 14_400),
  };
}

function isRejectionStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function clearPluginCopy(socialLogin: DropboxSocialLoginPort): Promise<void> {
  try {
    await socialLogin.clearStoredTokens();
  } catch (err) {
    console.warn('Could not clear the sign-in plugin’s Dropbox token copy:', err);
  }
}

export function createSecureDropboxBridge(options: {
  appKey: string;
  socialLogin: DropboxSocialLoginPort;
  secureStore: SecureStore;
  postToken: DropboxTokenPost;
  nowMs?: () => number;
}): DropboxPublicClientBridge {
  const { socialLogin, secureStore } = options;
  const nowMs = options.nowMs ?? (() => Date.now());

  return {
    authorize: async () => {
      const result = await socialLogin.login();
      try {
        const refreshToken = result.refreshToken ?? result.accessToken?.refreshToken;
        if (refreshToken) await secureStore.set(DROPBOX_REFRESH_TOKEN_KEY, refreshToken);
        else await secureStore.remove(DROPBOX_REFRESH_TOKEN_KEY);
        return loginToTokenSet(result, nowMs());
      } finally {
        await clearPluginCopy(socialLogin);
      }
    },
    refresh: async () => {
      const refreshToken = await secureStore.get(DROPBOX_REFRESH_TOKEN_KEY);
      if (!refreshToken) {
        throw new DropboxRefreshRejectedError('Not signed in to Dropbox on this device.');
      }
      const res = await options.postToken({
        client_id: options.appKey,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      const data = parseTokenResponse(res.data);
      if (res.status >= 200 && res.status < 300 && data.access_token) {
        if (data.refresh_token) {
          await secureStore.set(DROPBOX_REFRESH_TOKEN_KEY, data.refresh_token);
        }
        const expiresIn = Number(data.expires_in ?? 14_400);
        return {
          accessToken: data.access_token,
          expiresInSeconds: Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 14_400),
        };
      }
      const detail = data.error_description ?? data.error ?? `HTTP ${res.status}`;
      if (isRejectionStatus(res.status)) {
        throw new DropboxRefreshRejectedError(`Dropbox refresh failed: ${detail}`);
      }
      throw new Error(`Dropbox token endpoint returned ${res.status}: ${detail}`);
    },
    signOut: async () => {
      await secureStore.remove(DROPBOX_REFRESH_TOKEN_KEY);
      await clearPluginCopy(socialLogin);
    },
  };
}

/**
 * Moves a Dropbox refresh token from the sign-in plugin's plaintext store into the secure store,
 * then deletes the plugin's copy.
 */
export async function migrateDropboxRefreshToken(options: {
  socialLogin: DropboxSocialLoginPort;
  secureStore: SecureStore;
}): Promise<boolean> {
  const { socialLogin, secureStore } = options;
  const legacy = await socialLogin.readStoredTokens();
  if (legacy === null) return false;
  if (legacy.refreshToken && (await secureStore.get(DROPBOX_REFRESH_TOKEN_KEY)) === null) {
    await secureStore.set(DROPBOX_REFRESH_TOKEN_KEY, legacy.refreshToken);
  }
  await clearPluginCopy(socialLogin);
  return true;
}
