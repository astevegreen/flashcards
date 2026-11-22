/**
 * Loopback Microsoft sign-in for OneDrive on the Tauri desktop shell (§4.3, §15 Phase 12).
 *
 * MSAL has no Rust/Tauri SDK, so this speaks the protocol MSAL uses for public clients:
 * authorization code + PKCE in the system browser, redirected to a one-shot loopback listener
 * (RFC 8252), with no client secret. Microsoft rotates the refresh token on every redemption and
 * the newest one is written back to the OS keychain. Loaded only when the user connects OneDrive.
 */
import {
  cancel as cancelOAuthServer,
  onUrl,
  start as startOAuthServer,
} from '@fabianlars/tauri-plugin-oauth';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  MicrosoftRefreshRejectedError,
  type MicrosoftPublicClientBridge,
  type MicrosoftTokenSet,
} from '@flash/platform-web/onedrive';
import type { RefreshTokenStore } from '../auth/refresh-token-store.ts';

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

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** Reads `code` from the loopback callback URL after checking `state` and `error`. */
function codeFromCallback(callbackUrl: string, expectedState: string): string {
  const returned = new URL(callbackUrl);
  if (returned.searchParams.get('state') !== expectedState) {
    throw new Error('OAuth state mismatch.');
  }
  const err = returned.searchParams.get('error');
  if (err) throw new Error(`Microsoft sign-in failed: ${err}`);
  const code = returned.searchParams.get('code');
  if (!code) throw new Error('Microsoft sign-in returned no authorization code.');
  return code;
}

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
    if (data.refresh_token) await config.tokenStore.set(data.refresh_token);
    return { accessToken: data.access_token, expiresInSeconds: data.expires_in ?? 3600 };
  };

  return {
    authorize: async (scopes) => {
      const { verifier, challenge } = await createPkcePair();
      const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
      const port = await startOAuthServer({ response: SUCCESS_HTML });
      // Entra ignores the port of `http://localhost` redirect URIs registered for public clients.
      const redirectUri = `http://localhost:${port}`;
      let unlisten: (() => void) | null = null;
      try {
        const callback = new Promise<string>((resolve) => {
          void onUrl(resolve).then((fn) => {
            unlisten = fn;
          });
        });
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
        await openUrl(authUrl.toString());
        const code = codeFromCallback(await callback, state);
        return await tokenRequest(
          {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            scope: scopes.join(' '),
          },
          false,
        );
      } finally {
        (unlisten as (() => void) | null)?.();
        await cancelOAuthServer(port).catch(() => undefined);
      }
    },
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
