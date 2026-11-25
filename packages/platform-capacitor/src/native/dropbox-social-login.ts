/**
 * Dropbox App Folder sign-in on Android / iOS (§4.3, §16).
 *
 * Uses the generic OAuth2 provider of `@capgo/capacitor-social-login` with authorization code +
 * PKCE (`token_access_type=offline`, no client secret) in `ASWebAuthenticationSession` (iOS) or
 * Chrome Custom Tabs (Android, redirect `flashcards://oauth/dropbox` caught by the existing
 * `flashcards://oauth` intent filter in `AndroidManifest.xml`).
 *
 * Right after sign-in, `createSecureDropboxBridge` copies the refresh token to Keychain/Keystore
 * and deletes the plugin's plaintext copy; refreshes call Dropbox's token endpoint directly over
 * `CapacitorHttp`.
 */
import { CapacitorHttp } from '@capacitor/core';
import { SocialLogin } from '@capgo/capacitor-social-login';
import {
  DROPBOX_APP_FOLDER_SCOPES,
  type DropboxPublicClientBridge,
} from '@flash/platform-web/dropbox';
import {
  createSecureDropboxBridge,
  migrateDropboxRefreshToken,
  type DropboxOAuth2LoginResult,
  type DropboxSocialLoginPort,
} from '../auth/dropbox-secure-bridge.ts';
import {
  DROPBOX_SOCIAL_LOGIN_PROVIDER_ID as DROPBOX_PROVIDER_ID,
  type SecureStore,
} from '../secure/secure-store.ts';
import { assertNativeOAuthRedirect } from './deep-links.ts';
import { registerOAuth2Provider } from './oauth2-providers.ts';

/** Registered in the Dropbox App Console under OAuth 2 > Redirect URIs. */
export const DEFAULT_DROPBOX_NATIVE_REDIRECT = 'flashcards://oauth/dropbox';

const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

export interface DropboxSocialLoginConfig {
  appKey: string;
  redirectUrl?: string;
  secureStore: SecureStore;
}

function createSocialLoginPort(): DropboxSocialLoginPort {
  return {
    login: async () => {
      const res = await SocialLogin.login({
        provider: 'oauth2',
        options: {
          providerId: DROPBOX_PROVIDER_ID,
          scope: DROPBOX_APP_FOLDER_SCOPES.split(' '),
        },
      });
      return res.result as DropboxOAuth2LoginResult;
    },
    readStoredTokens: async () => {
      try {
        const stored = (await SocialLogin.getAuthorizationCode({
          provider: 'oauth2',
          providerId: DROPBOX_PROVIDER_ID,
        })) as { refreshToken?: string };
        return stored.refreshToken ? { refreshToken: stored.refreshToken } : {};
      } catch {
        return null;
      }
    },
    clearStoredTokens: async () => {
      await SocialLogin.logout({ provider: 'oauth2', providerId: DROPBOX_PROVIDER_ID });
    },
  };
}

export async function createDropboxSocialLoginBridge(
  config: DropboxSocialLoginConfig,
): Promise<DropboxPublicClientBridge> {
  await registerOAuth2Provider(DROPBOX_PROVIDER_ID, {
    appId: config.appKey,
    authorizationBaseUrl: DROPBOX_AUTHORIZE_URL,
    accessTokenEndpoint: DROPBOX_TOKEN_URL,
    redirectUrl: assertNativeOAuthRedirect(config.redirectUrl ?? DEFAULT_DROPBOX_NATIVE_REDIRECT),
    responseType: 'code',
    pkceEnabled: true,
    scope: DROPBOX_APP_FOLDER_SCOPES,
    additionalParameters: { token_access_type: 'offline' },
    androidUseCustomTabs: true,
    iosPrefersEphemeralWebBrowserSession: false,
  });

  const socialLogin = createSocialLoginPort();
  const bridge = createSecureDropboxBridge({
    appKey: config.appKey,
    socialLogin,
    secureStore: config.secureStore,
    postToken: async (form) => {
      const res = await CapacitorHttp.post({
        url: DROPBOX_TOKEN_URL,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: { ...form },
      });
      return { status: res.status, data: res.data as unknown };
    },
  });
  await migrateDropboxRefreshToken({ socialLogin, secureStore: config.secureStore });
  return bridge;
}
