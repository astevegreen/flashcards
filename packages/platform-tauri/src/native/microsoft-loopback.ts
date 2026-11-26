/**
 * Loopback Microsoft sign-in for OneDrive on the Tauri desktop shell (§4.3, §15 Phase 12).
 *
 * MSAL has no Rust/Tauri SDK, so this speaks the protocol MSAL uses for public clients:
 * authorization code + PKCE in the system browser, redirected to a one-shot loopback listener
 * (RFC 8252), with no client secret. Microsoft rotates the refresh token on every redemption and
 * the newest one is written back to the OS keychain. Loaded only when the user connects OneDrive.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
  MicrosoftRefreshRejectedError,
  type MicrosoftPublicClientBridge,
  type MicrosoftTokenSet,
} from '@flash/platform-web/onedrive';
import type { RefreshTokenStore } from '../auth/refresh-token-store.ts';
import { createLatestAttempt } from './browser-callback.ts';
import { runLoopbackSignIn } from './loopback-sign-in.ts';

export interface MicrosoftLoopbackConfig {
  /** Entra application (client) ID with a "Mobile and desktop" `http://localhost` redirect URI. */
  clientId: string;
  /** Authority tenant (default `consumers`: personal Microsoft accounts). */
  tenant?: string;
  tokenStore: RefreshTokenStore;
}

interface MicrosoftTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<body style="font-family:system-ui;padding:2rem">Signed in to OneDrive. You can close this tab and return to Flashcards.</body>';

export function createMicrosoftLoopbackBridge(
  config: MicrosoftLoopbackConfig,
): MicrosoftPublicClientBridge {
  const authority = `https://login.microsoftonline.com/${encodeURIComponent(config.tenant || 'consumers')}/oauth2/v2.0`;

  const tokenRequest = async (
    body: Record<string, string>,
    isRefresh: boolean,
  ): Promise<MicrosoftTokenSet> => {
    // Sent from Rust by tauri-plugin-http: Entra refuses cross-origin (WebView) redemption for
    // non-SPA redirect URIs.
    const res = await tauriFetch(`${authority}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, ...body }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as MicrosoftTokenResponse;
    if (!res.ok || !data.access_token) {
      const detail = data.error_description ?? data.error ?? `HTTP ${res.status}`;
      if (isRefresh && res.status >= 400 && res.status < 500) {
        throw new MicrosoftRefreshRejectedError(`Microsoft refresh failed: ${detail}`);
      }
      throw new Error(`Microsoft token endpoint returned ${res.status}: ${detail}`);
    }
    // A refresh that rotates nothing keeps the current token; a new sign-in without one must not
    // leave an older token behind (it may belong to another account).
    if (data.refresh_token) await config.tokenStore.set(data.refresh_token);
    else if (!isRefresh) await config.tokenStore.delete();
    return { accessToken: data.access_token, expiresInSeconds: data.expires_in ?? 3600 };
  };

  // A second Connect while the first browser tab is still open replaces the first attempt (N6).
  const latestAttempt = createLatestAttempt();

  return {
    authorize: (scopes) =>
      latestAttempt((signal) =>
        runLoopbackSignIn(
          {
            provider: 'Microsoft',
            label: 'OneDrive sign-in',
            successHtml: SUCCESS_HTML,
            // Entra ignores the port of `http://localhost` redirect URIs registered for public clients.
            redirectHost: 'localhost',
            signal,
            buildAuthUrl: ({ redirectUri, challenge, state }) => {
              const authUrl = new URL(`${authority}/authorize`);
              authUrl.search = new URLSearchParams({
                client_id: config.clientId,
                response_type: 'code',
                redirect_uri: redirectUri,
                response_mode: 'query',
                scope: scopes.join(' '),
                code_challenge: challenge,
                code_challenge_method: 'S256',
                state,
              }).toString();
              return authUrl.toString();
            },
          },
          ({ code, verifier, redirectUri }) =>
            tokenRequest(
              {
                grant_type: 'authorization_code',
                code,
                code_verifier: verifier,
                redirect_uri: redirectUri,
                scope: scopes.join(' '),
              },
              false,
            ),
        ),
      ),
    refresh: async (scopes) => {
      const refreshToken = await config.tokenStore.get();
      if (!refreshToken) throw new MicrosoftRefreshRejectedError('Not signed in to OneDrive.');
      return tokenRequest(
        { grant_type: 'refresh_token', refresh_token: refreshToken, scope: scopes.join(' ') },
        true,
      );
    },
    signOut: async () => {
      // Consumer refresh tokens have no revocation endpoint; forgetting it ends this device's session.
      await config.tokenStore.delete();
    },
  };
}
