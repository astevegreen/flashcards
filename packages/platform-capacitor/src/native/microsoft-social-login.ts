/**
 * OneDrive sign-in on Android / iOS (§4.3, §15 Phase 12, §16).
 *
 * No MSAL Capacitor plugin with verified Capacitor 8 support was found, so the sign-in itself uses
 * the generic OAuth2 provider of `@capgo/capacitor-social-login` (already a dependency; Capacitor 8):
 * the Microsoft identity platform public-client flow MSAL uses, authorization code + PKCE with no
 * client secret, in `ASWebAuthenticationSession` (iOS) or Chrome Custom Tabs (Android, redirect
 * `flashcards://oauth/microsoft` caught by the intent filter in `AndroidManifest.xml`).
 *
 * The plugin always saves the tokens it gets in UserDefaults / SharedPreferences, so
 * `createSecureMicrosoftBridge` moves the refresh token to the Keychain / Keystore right after
 * sign-in, deletes the plugin's copy, and refreshes over native HTTP itself. Loaded only when the
 * user connects OneDrive (or at launch, when OneDrive is already connected, to migrate old copies).
 */
import { CapacitorHttp } from '@capacitor/core';
import { SocialLogin } from '@capgo/capacitor-social-login';
import type { MicrosoftPublicClientBridge } from '@flash/platform-web/onedrive';
import {
  createSecureMicrosoftBridge,
  migrateMicrosoftRefreshToken,
  type MicrosoftOAuth2LoginResult,
  type MicrosoftSocialLoginPort,
} from '../auth/microsoft-secure-bridge.ts';
import {
  MICROSOFT_SOCIAL_LOGIN_PROVIDER_ID as MICROSOFT_PROVIDER_ID,
  type SecureStore,
} from '../secure/secure-store.ts';
import { assertNativeOAuthRedirect } from './deep-links.ts';

/** Registered in Entra under "Mobile and desktop applications" (custom scheme already claimed). */
export const DEFAULT_MICROSOFT_NATIVE_REDIRECT = 'flashcards://oauth/microsoft';

export interface MicrosoftSocialLoginConfig {
  clientId: string;
  tenant?: string;
  redirectUrl?: string;
  secureStore: SecureStore;
}

function createSocialLoginPort(): MicrosoftSocialLoginPort {
  return {
    login: async (scopes) => {
      const res = await SocialLogin.login({
        provider: 'oauth2',
        options: { providerId: MICROSOFT_PROVIDER_ID, scope: [...scopes] },
      });
      return res.result as MicrosoftOAuth2LoginResult;
    },
    readStoredTokens: async () => {
      try {
        const stored = (await SocialLogin.getAuthorizationCode({
          provider: 'oauth2',
          providerId: MICROSOFT_PROVIDER_ID,
        })) as { refreshToken?: string };
        return stored.refreshToken ? { refreshToken: stored.refreshToken } : {};
      } catch {
        // The plugin rejects when it holds no tokens for the provider.
        return null;
      }
    },
    clearStoredTokens: async () => {
      // No `logoutUrl` is configured, so this only deletes the plugin's stored tokens.
      await SocialLogin.logout({ provider: 'oauth2', providerId: MICROSOFT_PROVIDER_ID });
    },
  };
}

export async function createMicrosoftSocialLoginBridge(
  config: MicrosoftSocialLoginConfig,
): Promise<MicrosoftPublicClientBridge> {
  const authority = `https://login.microsoftonline.com/${encodeURIComponent(config.tenant || 'consumers')}/oauth2/v2.0`;
  await SocialLogin.initialize({
    oauth2: {
      [MICROSOFT_PROVIDER_ID]: {
        appId: config.clientId,
        authorizationBaseUrl: `${authority}/authorize`,
        accessTokenEndpoint: `${authority}/token`,
        redirectUrl: assertNativeOAuthRedirect(
          config.redirectUrl ?? DEFAULT_MICROSOFT_NATIVE_REDIRECT,
        ),
        responseType: 'code',
        pkceEnabled: true,
        scope: 'Files.ReadWrite.AppFolder offline_access',
        // RFC 8252: the system browser, not an embedded WebView. The plugin checks `state` and keeps
        // the PKCE verifier while the redirect comes back through the intent filter.
        androidUseCustomTabs: true,
        // Keep the Microsoft session cookie so a second sign-in (e.g. adding Files.Read) is one tap.
        iosPrefersEphemeralWebBrowserSession: false,
      },
    },
  });

  const socialLogin = createSocialLoginPort();
  const bridge = createSecureMicrosoftBridge({
    clientId: config.clientId,
    socialLogin,
    secureStore: config.secureStore,
    // Native HTTP sends no `Origin` header: Entra refuses cross-origin (WebView) token redemption
    // for "Mobile and desktop" redirect URIs.
    postToken: async (form) => {
      const res = await CapacitorHttp.post({
        url: `${authority}/token`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: { ...form },
      });
      return { status: res.status, data: res.data as unknown };
    },
  });
  await migrateMicrosoftRefreshToken({ socialLogin, secureStore: config.secureStore });
  return bridge;
}
