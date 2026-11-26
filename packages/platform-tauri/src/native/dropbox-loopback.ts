/**
 * Loopback Dropbox sign-in for the Tauri desktop shell (§4.3).
 *
 * Dropbox enforces exact-match redirect URIs (no dynamic port wildcard on localhost), so this
 * binds to a fixed loopback port (`DEFAULT_DROPBOX_LOOPBACK_PORTS`, default `53682`) and
 * redirects to `http://127.0.0.1:<port>`. Register `http://127.0.0.1:53682` (and optionally
 * `53683` as fallback) in the Dropbox App Console.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
  DROPBOX_APP_FOLDER_SCOPES,
  DropboxRefreshRejectedError,
  type DropboxPublicClientBridge,
  type DropboxTokenSet,
} from '@flash/platform-web/dropbox';
import type { RefreshTokenStore } from '../auth/refresh-token-store.ts';
import { createLatestAttempt } from './browser-callback.ts';
import { runLoopbackSignIn } from './loopback-sign-in.ts';

/** Fixed loopback ports registered in Dropbox App Console as `http://127.0.0.1:<port>`. */
export const DEFAULT_DROPBOX_LOOPBACK_PORTS = [53682, 53683] as const;

export interface DropboxLoopbackConfig {
  /** Dropbox App Folder app key (public PKCE client, no secret). */
  appKey: string;
  tokenStore: RefreshTokenStore;
  ports?: readonly number[];
}

interface DropboxTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<body style="font-family:system-ui;padding:2rem">Signed in to Dropbox. You can close this tab and return to Flashcards.</body>';

export function createDropboxLoopbackBridge(
  config: DropboxLoopbackConfig,
): DropboxPublicClientBridge {
  const ports = [...(config.ports ?? DEFAULT_DROPBOX_LOOPBACK_PORTS)];

  const tokenRequest = async (
    body: Record<string, string>,
    isRefresh: boolean,
  ): Promise<DropboxTokenSet> => {
    const res = await tauriFetch(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.appKey, ...body }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as DropboxTokenResponse;
    if (!res.ok || !data.access_token) {
      const detail = data.error_description ?? data.error ?? `HTTP ${res.status}`;
      if (isRefresh && res.status >= 400 && res.status < 500) {
        throw new DropboxRefreshRejectedError(`Dropbox refresh failed: ${detail}`);
      }
      throw new Error(`Dropbox token endpoint returned ${res.status}: ${detail}`);
    }
    if (data.refresh_token) await config.tokenStore.set(data.refresh_token);
    else if (!isRefresh) await config.tokenStore.delete();
    return { accessToken: data.access_token, expiresInSeconds: data.expires_in ?? 14_400 };
  };

  // A second Connect while the first browser tab is still open replaces the first attempt, which
  // frees its fixed port first (N6).
  const latestAttempt = createLatestAttempt();

  return {
    authorize: () =>
      latestAttempt((signal) =>
        runLoopbackSignIn(
          {
            provider: 'Dropbox',
            successHtml: SUCCESS_HTML,
            ports,
            signal,
            buildAuthUrl: ({ redirectUri, challenge, state }) => {
              const authUrl = new URL(DROPBOX_AUTHORIZE_URL);
              authUrl.search = new URLSearchParams({
                client_id: config.appKey,
                response_type: 'code',
                redirect_uri: redirectUri,
                token_access_type: 'offline',
                scope: DROPBOX_APP_FOLDER_SCOPES,
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
              },
              false,
            ),
        ),
      ),
    refresh: async () => {
      const refreshToken = await config.tokenStore.get();
      if (!refreshToken) throw new DropboxRefreshRejectedError('Not signed in to Dropbox.');
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, true);
    },
    signOut: async () => {
      await config.tokenStore.delete();
    },
  };
}
