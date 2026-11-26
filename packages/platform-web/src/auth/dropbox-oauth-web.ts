import { SyncTransportError } from '@flash/core';
import type { Auth, AuthSession, OAuthSignInIntent, Storage } from '@flash/platform';
import { buildDropboxPkceAuthUrl } from '../sync/dropbox-transport.ts';
import type { GoogleOAuthWindowLike } from './google-oauth-web.ts';
import { createPkcePair, randomBase64Url } from './pkce.ts';
import { isFreshPkce } from './pkce-expiry.ts';
import { reconnectRequiredTokens, requireAccessToken, TokenRefresher } from './token-refresher.ts';

const DROPBOX_TOKEN_ENDPOINT = 'https://api.dropboxapi.com/oauth2/token';
const DROPBOX_PKCE_KV_KEY = 'dropbox_oauth_pkce';
const DROPBOX_TOKENS_KV_KEY = 'dropbox_oauth_tokens';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const OAUTH_QUERY_KEYS = ['code', 'state', 'error', 'error_description'];

interface StoredDropboxPkce {
  verifier: string;
  state: string;
  redirectUri: string;
  returnSearch: string;
  intent?: OAuthSignInIntent;
  createdAt: number;
}

export interface StoredDropboxTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  accountId?: string;
  reconnectRequired?: boolean;
}

export interface DropboxOAuthWebOptions {
  /** Dropbox app key (public client; PKCE needs no secret, §4.3). */
  appKey: string;
  storage: Storage;
  fetchImpl?: typeof fetch;
  windowImpl?: GoogleOAuthWindowLike;
  nowMs?: () => number;
}

/**
 * Web/PWA Dropbox App Folder OAuth (PKCE redirect, offline refresh tokens).
 * Dropbox lets public clients exchange and refresh tokens directly, so unlike Google this
 * never needs the token-helper Worker. Tokens live only in this device's IndexedDB.
 */
export class DropboxOAuthWebAuth implements Auth {
  private readonly appKey: string;
  private readonly storage: Storage;
  private readonly fetchImpl: typeof fetch;
  private readonly windowImpl: GoogleOAuthWindowLike | undefined;
  private readonly nowMs: () => number;
  private readonly refresher: TokenRefresher<StoredDropboxTokens>;

  constructor(options: DropboxOAuthWebOptions) {
    this.appKey = options.appKey.trim();
    this.storage = options.storage;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.windowImpl =
      options.windowImpl ??
      (typeof window !== 'undefined' ? (window as unknown as GoogleOAuthWindowLike) : undefined);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.refresher = new TokenRefresher<StoredDropboxTokens>({
      label: 'Dropbox',
      marginMs: REFRESH_MARGIN_MS,
      nowMs: this.nowMs,
      read: () => this.storage.getKv<StoredDropboxTokens>(DROPBOX_TOKENS_KV_KEY),
      refresh: (tokens) => this.performRefresh(tokens),
      cannotRefreshMessage:
        'Dropbox access expired and no refresh token is stored. Please reconnect.',
    });
  }

  isConfigured(): boolean {
    return Boolean(this.appKey);
  }

  private getWindow(): GoogleOAuthWindowLike {
    if (!this.windowImpl) {
      throw new SyncTransportError(
        'UNKNOWN',
        'Browser window environment is unavailable for OAuth.',
      );
    }
    return this.windowImpl;
  }

  async isConnected(): Promise<boolean> {
    const tokens = await this.storage.getKv<StoredDropboxTokens>(DROPBOX_TOKENS_KV_KEY);
    if (!tokens || tokens.reconnectRequired) return false;
    return Boolean(tokens.refreshToken || (tokens.accessToken && tokens.expiresAt > this.nowMs()));
  }

  async getSession(): Promise<AuthSession | null> {
    const tokens = await this.storage.getKv<StoredDropboxTokens>(DROPBOX_TOKENS_KV_KEY);
    if (!tokens || tokens.reconnectRequired || !tokens.accessToken) return null;
    return { provider: 'dropbox', accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  async signIn(opts?: { intent?: OAuthSignInIntent }): Promise<AuthSession | null> {
    if (!this.isConfigured()) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Dropbox sync is not configured (missing VITE_DROPBOX_APP_KEY).',
      );
    }
    const win = this.getWindow();
    const { verifier, challenge } = await createPkcePair(win.crypto);
    const state = `dbx.${randomBase64Url(16, win.crypto)}`;
    const redirectUri = `${win.location.origin}${win.location.pathname}`;

    const existingParams = new URLSearchParams(win.location.search);
    for (const k of OAUTH_QUERY_KEYS) existingParams.delete(k);
    const cleanSearch = existingParams.toString();

    const pkce: StoredDropboxPkce = {
      verifier,
      state,
      redirectUri,
      returnSearch: cleanSearch ? `?${cleanSearch}` : '',
      ...(opts?.intent ? { intent: opts.intent } : {}),
      createdAt: this.nowMs(),
    };
    await this.storage.setKv(DROPBOX_PKCE_KV_KEY, pkce);
    win.location.assign(
      buildDropboxPkceAuthUrl({
        clientId: this.appKey,
        redirectUri,
        codeChallenge: challenge,
        state,
      }),
    );
    return null;
  }

  /**
   * Completes a Dropbox redirect. Returns `null` without touching the URL when the callback
   * isn't ours (no pending Dropbox PKCE or a different `state`), so Google can handle it.
   */
  async handleRedirectCallback(): Promise<AuthSession | null> {
    const win = this.windowImpl;
    if (!win) return null;
    const params = new URLSearchParams(win.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');
    if (!code && !error) return null;

    const pkce = await this.storage.getKv<StoredDropboxPkce>(DROPBOX_PKCE_KV_KEY);
    if (!pkce || !state || pkce.state !== state) return null;

    const cleaned = new URLSearchParams(win.location.search);
    for (const k of OAUTH_QUERY_KEYS) cleaned.delete(k);
    const fallbackSearch = cleaned.toString() ? `?${cleaned.toString()}` : '';
    win.history.replaceState(
      {},
      win.document?.title ?? '',
      `${win.location.origin}${win.location.pathname}${pkce.returnSearch || fallbackSearch}`,
    );
    await this.storage.deleteKv(DROPBOX_PKCE_KV_KEY);

    if (!isFreshPkce(pkce.createdAt, this.nowMs())) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Dropbox sign-in took too long. Please connect Dropbox again.',
      );
    }
    if (error) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        `Dropbox sign-in was cancelled or failed: ${params.get('error_description') ?? error}`,
      );
    }

    const data = await this.postToken(
      new URLSearchParams({
        code: code ?? '',
        grant_type: 'authorization_code',
        code_verifier: pkce.verifier,
        client_id: this.appKey,
        redirect_uri: pkce.redirectUri,
      }),
      'sign-in',
    );
    const accessToken = typeof data['access_token'] === 'string' ? data['access_token'] : '';
    if (!accessToken) {
      throw new SyncTransportError('AUTH_REQUIRED', 'Dropbox token response missing access_token.');
    }
    const expiresAt = this.nowMs() + this.expiresInSec(data) * 1000;
    const stored: StoredDropboxTokens = {
      accessToken,
      refreshToken: typeof data['refresh_token'] === 'string' ? data['refresh_token'] : null,
      expiresAt,
      reconnectRequired: false,
      ...(typeof data['account_id'] === 'string' ? { accountId: data['account_id'] } : {}),
    };
    await this.storage.setKv(DROPBOX_TOKENS_KV_KEY, stored);
    return {
      provider: 'dropbox',
      accessToken,
      expiresAt,
      ...(pkce.intent ? { intent: pkce.intent } : {}),
    };
  }

  getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    return this.refresher.getValidAccessToken(opts);
  }

  private async performRefresh(tokens: StoredDropboxTokens): Promise<string> {
    let data: Record<string, unknown>;
    try {
      data = await this.postToken(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken ?? '',
          client_id: this.appKey,
        }),
        'refresh',
      );
    } catch (err) {
      if (err instanceof SyncTransportError && err.code === 'AUTH_REQUIRED') {
        await this.storage.setKv(DROPBOX_TOKENS_KV_KEY, reconnectRequiredTokens(tokens));
      }
      throw err;
    }
    const accessToken = requireAccessToken(data, 'Dropbox');
    await this.storage.setKv(DROPBOX_TOKENS_KV_KEY, {
      ...tokens,
      accessToken,
      expiresAt: this.nowMs() + this.expiresInSec(data) * 1000,
      reconnectRequired: false,
    } satisfies StoredDropboxTokens);
    return accessToken;
  }

  private expiresInSec(data: Record<string, unknown>): number {
    return typeof data['expires_in'] === 'number' && data['expires_in'] > 0
      ? data['expires_in']
      : 14_400;
  }

  private async postToken(
    body: URLSearchParams,
    phase: 'sign-in' | 'refresh',
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(DROPBOX_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      throw new SyncTransportError(
        'NETWORK',
        `Dropbox ${phase} failed (offline or unreachable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return data;
    const detail =
      typeof data['error_description'] === 'string'
        ? data['error_description']
        : typeof data['error'] === 'string'
          ? data['error']
          : `HTTP ${res.status}`;
    if (res.status === 429) {
      throw new SyncTransportError('RATE_LIMITED', `Dropbox ${phase} rate limited.`, res.status);
    }
    if (res.status >= 500) {
      throw new SyncTransportError(
        'NETWORK',
        `Dropbox ${phase} unavailable: ${detail}`,
        res.status,
      );
    }
    throw new SyncTransportError('AUTH_REQUIRED', `Dropbox ${phase} failed: ${detail}`, res.status);
  }

  async signOut(): Promise<void> {
    this.refresher.reset();
    await this.storage.deleteKv(DROPBOX_TOKENS_KV_KEY);
    await this.storage.deleteKv(DROPBOX_PKCE_KV_KEY);
  }
}
