/**
 * OneDrive public-client bridge for Android / iOS that keeps the Microsoft refresh token only in the
 * Keychain / Keystore (§13, §16). Pure and injectable; `native/microsoft-social-login.ts` wires the
 * real plugins.
 *
 * `@capgo/capacitor-social-login` still runs the sign-in (authorization code + PKCE in
 * ASWebAuthenticationSession / Custom Tabs), but it always writes the tokens it receives to
 * UserDefaults / SharedPreferences. So after every sign-in the refresh token is copied to the secure
 * store and the plugin's copy is deleted. Refreshes never go through the plugin (it would write the
 * new tokens back): they call the Microsoft token endpoint directly over native HTTP.
 */
import {
  MicrosoftRefreshRejectedError,
  type MicrosoftPublicClientBridge,
  type MicrosoftTokenSet,
} from '@flash/platform-web/onedrive';
import { MICROSOFT_REFRESH_TOKEN_KEY, type SecureStore } from '../secure/secure-store.ts';

/** The subset of the plugin's OAuth2 login response this bridge reads. */
export interface MicrosoftOAuth2LoginResult {
  accessToken: { token: string; expires?: string; refreshToken?: string } | null;
  refreshToken?: string | null;
  expiresIn?: number | null;
}

/** The sign-in plugin, reduced to what this bridge needs. */
export interface MicrosoftSocialLoginPort {
  login(scopes: readonly string[]): Promise<MicrosoftOAuth2LoginResult>;
  /** The plugin's own persisted copy, or `null` when it holds none. */
  readStoredTokens(): Promise<{ refreshToken?: string } | null>;
  /** Deletes the plugin's persisted copy. */
  clearStoredTokens(): Promise<void>;
}

/** POSTs an `application/x-www-form-urlencoded` body to the token endpoint (native HTTP, no Origin). */
export type MicrosoftTokenPost = (
  form: Readonly<Record<string, string>>,
) => Promise<{ status: number; data: unknown }>;

interface MicrosoftTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

function parseTokenResponse(data: unknown): MicrosoftTokenResponse {
  if (typeof data === 'string') {
    try {
      return parseTokenResponse(JSON.parse(data) as unknown);
    } catch {
      return {};
    }
  }
  return data !== null && typeof data === 'object' ? (data as MicrosoftTokenResponse) : {};
}

function loginToTokenSet(result: MicrosoftOAuth2LoginResult, nowMs: number): MicrosoftTokenSet {
  const token = result.accessToken?.token;
  if (!token) throw new Error('Microsoft sign-in returned no access token.');
  const expiresAt = result.accessToken?.expires
    ? Date.parse(result.accessToken.expires)
    : Number.NaN;
  const fromExpiry = Number.isNaN(expiresAt) ? null : Math.round((expiresAt - nowMs) / 1000);
  return {
    accessToken: token,
    expiresInSeconds: Math.max(60, result.expiresIn ?? fromExpiry ?? 3600),
  };
}

/**
 * A 4xx answer means the stored refresh token is no good (`invalid_grant`, revoked consent, …) and
 * the user has to sign in again. Timeouts and throttling (408, 429) are retried like network errors.
 */
function isRejectionStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function clearPluginCopy(socialLogin: MicrosoftSocialLoginPort): Promise<void> {
  try {
    await socialLogin.clearStoredTokens();
  } catch (err) {
    // The next launch's migration deletes it again (`migrateMicrosoftRefreshToken`).
    console.warn('Could not clear the sign-in plugin’s Microsoft token copy:', err);
  }
}

export function createSecureMicrosoftBridge(options: {
  clientId: string;
  socialLogin: MicrosoftSocialLoginPort;
  secureStore: SecureStore;
  postToken: MicrosoftTokenPost;
  nowMs?: () => number;
}): MicrosoftPublicClientBridge {
  const { socialLogin, secureStore } = options;
  const nowMs = options.nowMs ?? (() => Date.now());

  return {
    authorize: async (scopes) => {
      const result = await socialLogin.login(scopes);
      try {
        const refreshToken = result.refreshToken ?? result.accessToken?.refreshToken;
        // A sign-in without a refresh token must not leave an older one behind: it may belong to
        // another account, and later refreshes would silently switch back to it.
        if (refreshToken) await secureStore.set(MICROSOFT_REFRESH_TOKEN_KEY, refreshToken);
        else await secureStore.remove(MICROSOFT_REFRESH_TOKEN_KEY);
        return loginToTokenSet(result, nowMs());
      } finally {
        // Runs even when the secure write fails: the token must not stay in plaintext storage.
        await clearPluginCopy(socialLogin);
      }
    },
    refresh: async (scopes) => {
      const refreshToken = await secureStore.get(MICROSOFT_REFRESH_TOKEN_KEY);
      if (!refreshToken) {
        throw new MicrosoftRefreshRejectedError('Not signed in to OneDrive on this device.');
      }
      const res = await options.postToken({
        client_id: options.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: scopes.join(' '),
      });
      const data = parseTokenResponse(res.data);
      if (res.status >= 200 && res.status < 300 && data.access_token) {
        // Microsoft rotates refresh tokens; keep the newest one.
        if (data.refresh_token) {
          await secureStore.set(MICROSOFT_REFRESH_TOKEN_KEY, data.refresh_token);
        }
        const expiresIn = Number(data.expires_in ?? 3600);
        return {
          accessToken: data.access_token,
          expiresInSeconds: Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 3600),
        };
      }
      const detail = data.error_description ?? data.error ?? `HTTP ${res.status}`;
      if (isRejectionStatus(res.status)) {
        throw new MicrosoftRefreshRejectedError(`Microsoft refresh failed: ${detail}`);
      }
      throw new Error(`Microsoft token endpoint returned ${res.status}: ${detail}`);
    },
    signOut: async () => {
      // Consumer refresh tokens have no revocation endpoint; forgetting it ends this device's session.
      await secureStore.remove(MICROSOFT_REFRESH_TOKEN_KEY);
      await clearPluginCopy(socialLogin);
    },
  };
}

/**
 * Moves a refresh token that an older build left in the sign-in plugin's plaintext store into the
 * secure store, then deletes the plugin's copy. A token already in the secure store wins: refreshes
 * rotate it there, so it is the newer one. Returns whether the plugin held a copy.
 */
export async function migrateMicrosoftRefreshToken(options: {
  socialLogin: MicrosoftSocialLoginPort;
  secureStore: SecureStore;
}): Promise<boolean> {
  const { socialLogin, secureStore } = options;
  const legacy = await socialLogin.readStoredTokens();
  if (legacy === null) return false;
  if (legacy.refreshToken && (await secureStore.get(MICROSOFT_REFRESH_TOKEN_KEY)) === null) {
    await secureStore.set(MICROSOFT_REFRESH_TOKEN_KEY, legacy.refreshToken);
  }
  // The token is safe in the secure store by now, so a failed clean-up must not block OneDrive; the
  // next launch retries it.
  await clearPluginCopy(socialLogin);
  return true;
}
