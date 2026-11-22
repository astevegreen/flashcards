/**
 * OneDrive sign-in on Android / iOS (§4.3, §15 Phase 12).
 *
 * No MSAL Capacitor plugin with verified Capacitor 8 support was found, so this uses the generic
 * OAuth2 provider of `@capgo/capacitor-social-login` (already a dependency; Capacitor 8). It runs
 * the same Microsoft identity platform public-client flow MSAL uses: authorization code + PKCE in
 * `ASWebAuthenticationSession` (iOS) / an in-app browser (Android), no client secret, and rolling
 * refresh tokens kept by the plugin. Loaded only when the user connects OneDrive.
 */
import { SocialLogin } from '@capgo/capacitor-social-login';
import {
  MicrosoftRefreshRejectedError,
  type MicrosoftPublicClientBridge,
  type MicrosoftTokenSet,
} from '@flash/platform-web/onedrive';

const PROVIDER_ID = 'microsoft';
/** Registered in Entra under "Mobile and desktop applications" (custom scheme already claimed). */
export const DEFAULT_MICROSOFT_NATIVE_REDIRECT = 'flashcards://oauth/microsoft';

export interface MicrosoftSocialLoginConfig {
  clientId: string;
  tenant?: string;
  redirectUrl?: string;
}

interface OAuth2Result {
  accessToken: { token: string; expires?: string } | null;
  expiresIn: number | null;
}

function toTokenSet(result: OAuth2Result): MicrosoftTokenSet {
  const token = result.accessToken?.token;
  if (!token) throw new Error('Microsoft sign-in returned no access token.');
  const expiresAt = result.accessToken?.expires
    ? Date.parse(result.accessToken.expires)
    : Number.NaN;
  const fromExpiry = Number.isNaN(expiresAt) ? null : Math.round((expiresAt - Date.now()) / 1000);
  return {
    accessToken: token,
    expiresInSeconds: Math.max(60, result.expiresIn ?? fromExpiry ?? 3600),
  };
}

/** Errors that mean the refresh token is no longer valid (vs. being offline). */
function isGrantRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /invalid_grant|interaction_required|AADSTS(?:50173|70000|70008|700082|54005)/.test(
    message,
  );
}

export async function createMicrosoftSocialLoginBridge(
  config: MicrosoftSocialLoginConfig,
): Promise<MicrosoftPublicClientBridge> {
  const authority = `https://login.microsoftonline.com/${encodeURIComponent(config.tenant || 'consumers')}/oauth2/v2.0`;
  await SocialLogin.initialize({
    oauth2: {
      [PROVIDER_ID]: {
        appId: config.clientId,
        authorizationBaseUrl: `${authority}/authorize`,
        accessTokenEndpoint: `${authority}/token`,
        redirectUrl: config.redirectUrl ?? DEFAULT_MICROSOFT_NATIVE_REDIRECT,
        responseType: 'code',
        pkceEnabled: true,
        scope: 'Files.ReadWrite.AppFolder offline_access',
        // Keep the Microsoft session cookie so a second sign-in (e.g. adding Files.Read) is one tap.
        iosPrefersEphemeralWebBrowserSession: false,
      },
    },
  });

  return {
    authorize: async (scopes) => {
      const res = await SocialLogin.login({
        provider: 'oauth2',
        options: { providerId: PROVIDER_ID, scope: [...scopes] },
      });
      return toTokenSet(res.result as OAuth2Result);
    },
    refresh: async (scopes) => {
      try {
        const res = await SocialLogin.refreshToken({
          provider: 'oauth2',
          providerId: PROVIDER_ID,
          additionalParameters: { scope: scopes.join(' ') },
        });
        return toTokenSet(res as OAuth2Result);
      } catch (err) {
        if (isGrantRejection(err)) {
          throw new MicrosoftRefreshRejectedError(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    },
    signOut: async () => {
      await SocialLogin.logout({ provider: 'oauth2', providerId: PROVIDER_ID });
    },
  };
}
