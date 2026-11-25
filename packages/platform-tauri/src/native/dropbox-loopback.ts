/**
 * Loopback Dropbox sign-in for the Tauri desktop shell (§4.3).
 *
 * Dropbox enforces exact-match redirect URIs (no dynamic port wildcard on localhost), so this
 * binds to a fixed loopback port (`DEFAULT_DROPBOX_LOOPBACK_PORTS`, default `53682`) and
 * redirects to `http://127.0.0.1:<port>`. Register `http://127.0.0.1:53682` (and optionally
 * `53683` as fallback) in the Dropbox App Console.
 */
import {
  cancel as cancelOAuthServer,
  onUrl,
  start as startOAuthServer,
} from '@fabianlars/tauri-plugin-oauth';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  DROPBOX_APP_FOLDER_SCOPES,
  DropboxRefreshRejectedError,
  type DropboxPublicClientBridge,
  type DropboxTokenSet,
} from '@flash/platform-web/dropbox';
import type { RefreshTokenStore } from '../auth/refresh-token-store.ts';

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

function codeFromCallback(callbackUrl: string, expectedState: string): string {
  const returned = new URL(callbackUrl);
  if (returned.searchParams.get('state') !== expectedState) {
    throw new Error('OAuth state mismatch.');
  }
  const err = returned.searchParams.get('error');
  if (err) throw new Error(`Dropbox sign-in failed: ${err}`);
  const code = returned.searchParams.get('code');
  if (!code) throw new Error('Dropbox sign-in returned no authorization code.');
  return code;
}

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

  return {
    authorize: async () => {
      const { verifier, challenge } = await createPkcePair();
      const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
      const port = await startOAuthServer({ ports, response: SUCCESS_HTML });
      const redirectUri = `http://127.0.0.1:${port}`;
      let unlisten: (() => void) | null = null;
      try {
        const callback = new Promise<string>((resolve) => {
          void onUrl(resolve).then((fn) => {
            unlisten = fn;
          });
        });
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
        await openUrl(authUrl.toString());
        const code = codeFromCallback(await callback, state);
        return await tokenRequest(
          {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
          },
          false,
        );
      } finally {
        (unlisten as (() => void) | null)?.();
        await cancelOAuthServer(port).catch(() => undefined);
      }
    },
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
