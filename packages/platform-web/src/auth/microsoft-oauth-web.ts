import { SyncTransportError } from '@flash/core';
import type { Auth, AuthSession, OAuthSignInIntent, Storage } from '@flash/platform';
import type { GoogleOAuthWindowLike } from './google-oauth-web.ts';

/** OneDrive app-folder sync scopes (least privilege, §13). */
export const MICROSOFT_SYNC_SCOPES = ['Files.ReadWrite.AppFolder', 'offline_access'] as const;
/** Optional read-only scope for the OneDrive file picker (incremental consent). */
export const MICROSOFT_PICKER_SCOPE = 'Files.Read';
export const DEFAULT_MICROSOFT_TENANT = 'consumers';

const MS_PKCE_KV_KEY = 'onedrive_oauth_pkce';
const MS_TOKENS_KV_KEY = 'onedrive_oauth_tokens';
const MS_STATE_PREFIX = 'ms.';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_EXPIRES_IN_SEC = 3600;
const OAUTH_QUERY_KEYS = ['code', 'state', 'error', 'error_description', 'error_uri'];

interface StoredMicrosoftPkce {
  verifier: string;
  state: string;
  redirectUri: string;
  returnSearch: string;
  /** Space-separated scopes requested in this sign-in. */
  scope: string;
  createdAt: number;
  intent?: OAuthSignInIntent;
}

export interface StoredMicrosoftTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  /** Space-separated scopes the user consented to (short names, as requested). */
  scope: string;
  reconnectRequired?: boolean;
}

export interface MicrosoftOAuthWebOptions {
  /** Entra application (client) ID. Public value; the secret lives only in the token helper. */
  clientId: string;
  /** Stateless token-helper Worker origin serving `/ms/exchange` and `/ms/refresh` (§12.3). */
  tokenHelperUrl: string;
  /** Entra authority tenant (default `consumers`: personal Microsoft accounts). */
  tenant?: string;
  storage: Storage;
  fetchImpl?: typeof fetch;
  windowImpl?: GoogleOAuthWindowLike;
  nowMs?: () => number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function scopeSet(scope: string): Set<string> {
  return new Set(scope.split(' ').filter((s) => s.length > 0));
}

function joinScopes(scopes: Iterable<string>): string {
  return [...new Set(scopes)].join(' ');
}

function stringOf(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

/** Builds the Microsoft identity platform v2 authorize URL (authorization code + PKCE). */
export function buildMicrosoftAuthorizeUrl(params: {
  tenant: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(params.tenant)}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Web/PWA Microsoft sign-in for the OneDrive storage connector (§4.3, §15 Phase 12).
 *
 * Same shape as Google on web: an authorization-code + PKCE redirect, with the code exchange and
 * every refresh routed through the stateless token helper (`/ms/exchange`, `/ms/refresh`) as a
 * confidential client. Microsoft gives SPA-registered clients 24-hour refresh tokens, so the
 * Worker keeps sync working without daily re-sign-in. Tokens live only in this device's
 * IndexedDB; Microsoft rotates the refresh token on every refresh and the new one is stored.
 */
export class MicrosoftOAuthWebAuth implements Auth {
  private readonly clientId: string;
  private readonly tokenHelperUrl: string;
  private readonly tenant: string;
  private readonly storage: Storage;
  private readonly fetchImpl: typeof fetch;
  private readonly windowImpl: GoogleOAuthWindowLike | undefined;
  private readonly nowMs: () => number;
  private inFlightRefresh: Promise<string> | null = null;

  constructor(options: MicrosoftOAuthWebOptions) {
    this.clientId = options.clientId.trim();
    this.tokenHelperUrl = trimTrailingSlashes(options.tokenHelperUrl.trim());
    this.tenant = options.tenant?.trim() || DEFAULT_MICROSOFT_TENANT;
    this.storage = options.storage;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.windowImpl =
      options.windowImpl ??
      (typeof window === 'undefined' ? undefined : (window as unknown as GoogleOAuthWindowLike));
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.tokenHelperUrl);
  }

  private async readTokens(): Promise<StoredMicrosoftTokens | undefined> {
    return this.storage.getKv<StoredMicrosoftTokens>(MS_TOKENS_KV_KEY);
  }

  async isConnected(): Promise<boolean> {
    const tokens = await this.readTokens();
    if (!tokens || tokens.reconnectRequired) return false;
    return Boolean(tokens.refreshToken || tokens.expiresAt > this.nowMs());
  }

  /** True when the stored consent includes `scope` (e.g. `Files.Read` for the picker). */
  async hasScope(scope: string): Promise<boolean> {
    const tokens = await this.readTokens();
    return Boolean(tokens && !tokens.reconnectRequired && scopeSet(tokens.scope).has(scope));
  }

  async getSession(): Promise<AuthSession | null> {
    const tokens = await this.readTokens();
    if (!tokens || tokens.reconnectRequired || !tokens.accessToken) return null;
    return {
      provider: 'onedrive',
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    };
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

  /**
   * Redirects to Microsoft sign-in (always returns `null`; the page navigates away).
   * `intent: 'sources'` adds the picker's `Files.Read` scope; scopes granted earlier are kept.
   */
  async signIn(opts?: { intent?: OAuthSignInIntent }): Promise<AuthSession | null> {
    if (!this.isConfigured()) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'OneDrive is not configured (missing VITE_MS_CLIENT_ID or VITE_TOKEN_HELPER_URL).',
      );
    }
    const win = this.getWindow();
    const verifier = base64UrlEncode(win.crypto.getRandomValues(new Uint8Array(32)));
    const digest = await win.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const state = `${MS_STATE_PREFIX}${base64UrlEncode(win.crypto.getRandomValues(new Uint8Array(16)))}`;
    const redirectUri = `${win.location.origin}${win.location.pathname}`;
    const existing = await this.readTokens();
    const scopes = [
      ...MICROSOFT_SYNC_SCOPES,
      ...(existing && !existing.reconnectRequired ? scopeSet(existing.scope) : []),
      ...(opts?.intent === 'sources' ? [MICROSOFT_PICKER_SCOPE] : []),
    ];
    const scope = joinScopes(scopes);

    const returnParams = new URLSearchParams(win.location.search);
    for (const k of OAUTH_QUERY_KEYS) returnParams.delete(k);
    const returnSearch = returnParams.toString();

    const pkce: StoredMicrosoftPkce = {
      verifier,
      state,
      redirectUri,
      returnSearch: returnSearch ? `?${returnSearch}` : '',
      scope,
      createdAt: this.nowMs(),
      ...(opts?.intent ? { intent: opts.intent } : {}),
    };
    await this.storage.setKv(MS_PKCE_KV_KEY, pkce);
    win.location.assign(
      buildMicrosoftAuthorizeUrl({
        tenant: this.tenant,
        clientId: this.clientId,
        redirectUri,
        scope,
        state,
        codeChallenge: base64UrlEncode(new Uint8Array(digest)),
      }),
    );
    return null;
  }

  /**
   * Completes a Microsoft redirect. Returns `null` without touching the URL when the callback
   * isn't ours (no pending Microsoft PKCE or a different `state`), so Google can handle it.
   */
  async handleRedirectCallback(): Promise<AuthSession | null> {
    const win = this.windowImpl;
    if (!win) return null;
    const params = new URLSearchParams(win.location.search);
    const state = params.get('state');
    if (!state?.startsWith(MS_STATE_PREFIX)) return null;
    const pkce = await this.storage.getKv<StoredMicrosoftPkce>(MS_PKCE_KV_KEY);
    if (!pkce || pkce.state !== state) return null;

    win.history.replaceState(
      {},
      win.document?.title ?? '',
      `${win.location.origin}${win.location.pathname}${pkce.returnSearch}`,
    );
    await this.storage.deleteKv(MS_PKCE_KV_KEY);

    const error = params.get('error');
    if (error) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        `Microsoft sign-in was cancelled or failed: ${params.get('error_description') ?? error}`,
      );
    }
    const data = await this.postHelper('/ms/exchange', 'sign-in', {
      code: params.get('code') ?? '',
      redirect_uri: pkce.redirectUri,
      code_verifier: pkce.verifier,
      scope: pkce.scope,
    });
    const accessToken = stringOf(data, 'access_token');
    if (!accessToken) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Microsoft token response missing access_token.',
      );
    }
    const stored: StoredMicrosoftTokens = {
      accessToken,
      refreshToken: stringOf(data, 'refresh_token') || null,
      expiresAt: this.nowMs() + this.expiresInSec(data) * 1000,
      scope: pkce.scope,
      reconnectRequired: false,
    };
    await this.storage.setKv(MS_TOKENS_KV_KEY, stored);
    return {
      provider: 'onedrive',
      accessToken,
      expiresAt: stored.expiresAt,
      scope: stored.scope,
      ...(pkce.intent ? { intent: pkce.intent } : {}),
    };
  }

  async getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    const tokens = await this.readTokens();
    if (!tokens) throw new SyncTransportError('AUTH_REQUIRED', 'OneDrive is not connected.');
    if (tokens.reconnectRequired) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'OneDrive session expired. Please reconnect in Settings.',
      );
    }
    const fresh =
      !opts?.forceRefresh &&
      Boolean(tokens.accessToken) &&
      tokens.expiresAt - this.nowMs() > REFRESH_MARGIN_MS;
    if (fresh) return tokens.accessToken;
    if (!tokens.refreshToken) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'OneDrive access expired and no refresh token is stored. Please reconnect.',
      );
    }
    this.inFlightRefresh ??= this.performRefresh(tokens).finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async performRefresh(tokens: StoredMicrosoftTokens): Promise<string> {
    let data: Record<string, unknown>;
    try {
      data = await this.postHelper('/ms/refresh', 'refresh', {
        refresh_token: tokens.refreshToken ?? '',
        scope: tokens.scope,
      });
    } catch (err) {
      if (err instanceof SyncTransportError && err.code === 'AUTH_REQUIRED') {
        await this.storage.setKv(MS_TOKENS_KV_KEY, {
          ...tokens,
          accessToken: '',
          expiresAt: 0,
          reconnectRequired: true,
        } satisfies StoredMicrosoftTokens);
      }
      throw err;
    }
    const accessToken = stringOf(data, 'access_token');
    if (!accessToken) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Microsoft refresh response missing access_token.',
      );
    }
    await this.storage.setKv(MS_TOKENS_KV_KEY, {
      ...tokens,
      accessToken,
      // Microsoft rotates refresh tokens; keep the newest one.
      refreshToken: stringOf(data, 'refresh_token') || tokens.refreshToken,
      expiresAt: this.nowMs() + this.expiresInSec(data) * 1000,
      reconnectRequired: false,
    } satisfies StoredMicrosoftTokens);
    return accessToken;
  }

  private expiresInSec(data: Record<string, unknown>): number {
    const raw = data['expires_in'];
    const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    return typeof value === 'number' && value > 0 ? value : DEFAULT_EXPIRES_IN_SEC;
  }

  private async postHelper(
    path: '/ms/exchange' | '/ms/refresh',
    phase: 'sign-in' | 'refresh',
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    if (!this.tokenHelperUrl) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'OneDrive needs the token helper (VITE_TOKEN_HELPER_URL).',
      );
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.tokenHelperUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SyncTransportError(
        'NETWORK',
        `Microsoft ${phase} failed (offline or token helper unreachable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return data;
    const detail =
      stringOf(data, 'error_description') || stringOf(data, 'error') || `HTTP ${res.status}`;
    if (res.status === 429) {
      throw new SyncTransportError('RATE_LIMITED', `Microsoft ${phase} rate limited.`, res.status);
    }
    if (res.status >= 500) {
      throw new SyncTransportError(
        'NETWORK',
        `Microsoft ${phase} unavailable: ${detail}`,
        res.status,
      );
    }
    throw new SyncTransportError(
      'AUTH_REQUIRED',
      `Microsoft ${phase} failed: ${detail}`,
      res.status,
    );
  }

  async signOut(): Promise<void> {
    this.inFlightRefresh = null;
    await this.storage.deleteKv(MS_TOKENS_KV_KEY);
    await this.storage.deleteKv(MS_PKCE_KV_KEY);
  }
}
