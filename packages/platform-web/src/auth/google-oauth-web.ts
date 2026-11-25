import { SyncTransportError } from '@flash/core';
import type { Auth, AuthSession, OAuthSignInIntent, Storage } from '@flash/platform';

export const GOOGLE_OAUTH_SCOPES =
  'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_PKCE_KV_KEY = 'oauth_pkce';
const OAUTH_TOKENS_KV_KEY = 'oauth_tokens';
const OAUTH_HELPER_DOWN_KV_KEY = 'oauth_token_helper_unavailable';
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // Silently refresh 5 minutes before expiry

interface StoredPkce {
  verifier: string;
  state: string;
  redirectUri: string;
  returnSearch: string;
  createdAt: number;
  intent?: OAuthSignInIntent;
}

export interface StoredOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope?: string;
  reconnectRequired?: boolean;
}

export interface GoogleOAuthWindowLike {
  location: {
    origin: string;
    pathname: string;
    search: string;
    assign(url: string): void;
  };
  history: {
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
  crypto: {
    getRandomValues<T extends ArrayBufferView>(array: T): T;
    subtle: {
      digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer>;
    };
  };
  document?: {
    title?: string;
  };
}

export interface GoogleOAuthWebOptions {
  clientId: string;
  tokenHelperUrl: string;
  storage: Storage;
  fetchImpl?: typeof fetch;
  windowImpl?: GoogleOAuthWindowLike;
  nowMs?: () => number;
}

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

interface GisGlobal {
  accounts?: {
    oauth2?: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (resp: GisTokenResponse) => void;
        error_callback?: (err: { type?: string; message?: string }) => void;
      }): GisTokenClient;
    };
  };
}

let gisScriptPromise: Promise<GisGlobal> | null = null;

/** Lazily loads Google Identity Services (only ever needed for the Worker-less fallback). */
function loadGis(): Promise<GisGlobal> {
  const existing = (globalThis as { google?: GisGlobal }).google;
  if (existing?.accounts?.oauth2) return Promise.resolve(existing);
  if (gisScriptPromise) return gisScriptPromise;
  gisScriptPromise = new Promise<GisGlobal>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new SyncTransportError('UNKNOWN', 'Google Identity Services needs a browser.'));
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      const g = (globalThis as { google?: GisGlobal }).google;
      if (g?.accounts?.oauth2) {
        resolve(g);
        return;
      }
      gisScriptPromise = null;
      reject(new SyncTransportError('UNKNOWN', 'Google Identity Services failed to load.'));
    };
    script.onerror = () => {
      gisScriptPromise = null;
      reject(new SyncTransportError('NETWORK', 'Unable to load Google Identity Services.'));
    };
    document.head.appendChild(script);
  });
  return gisScriptPromise;
}

function isProbablyOnline(): boolean {
  return (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Web/PWA Google OAuth 2.0 PKCE redirect + silent refresh adapter (§4.3 & §12.3).
 * Exchanges authorization codes and refreshes tokens through the stateless
 * Cloudflare Worker (`apps/token-helper`) while storing `refresh_token` strictly
 * in the user's local IndexedDB.
 */
export class GoogleOAuthWebAuth implements Auth {
  private readonly clientId: string;
  private readonly tokenHelperUrl: string;
  private readonly storage: Storage;
  private readonly fetchImpl: typeof fetch;
  private readonly windowImpl: GoogleOAuthWindowLike | undefined;
  private readonly nowMs: () => number;
  private inFlightRefresh: Promise<string> | null = null;

  constructor(options: GoogleOAuthWebOptions) {
    this.clientId = options.clientId.trim();
    this.tokenHelperUrl = options.tokenHelperUrl.trim().replace(/\/+$/, '');
    this.storage = options.storage;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.windowImpl =
      options.windowImpl ??
      (typeof window !== 'undefined' ? (window as unknown as GoogleOAuthWindowLike) : undefined);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  isConfigured(): boolean {
    // The Worker is optional: without it access is renewed with a GIS tap (section 4.3 / 12.3).
    return Boolean(this.clientId);
  }

  async needsInteractiveRenew(): Promise<boolean> {
    if (!this.clientId) return false;
    const needed =
      !this.tokenHelperUrl ||
      Boolean(await this.storage.getKv<{ since: number }>(OAUTH_HELPER_DOWN_KV_KEY));
    // Warm the GIS script so the popup can open straight from the user's tap.
    if (needed) void loadGis().catch(() => {});
    return needed;
  }

  /**
   * Google Identity Services tap-to-renew: gets a fresh access token in a popup with no
   * Worker involved. Must be called from a user gesture. Keeps any stored refresh token so the
   * normal silent path resumes automatically once the Worker is back.
   */
  async renewInteractively(opts?: { intent?: OAuthSignInIntent }): Promise<AuthSession> {
    if (!this.clientId) {
      throw new SyncTransportError('AUTH_REQUIRED', 'Google Drive sync is not configured.');
    }
    const gis = await loadGis();
    const oauth2 = gis.accounts?.oauth2;
    if (!oauth2) {
      throw new SyncTransportError('UNKNOWN', 'Google Identity Services is unavailable.');
    }
    const resp = await new Promise<GisTokenResponse>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: this.clientId,
        scope: GOOGLE_OAUTH_SCOPES,
        callback: resolve,
        error_callback: (err) =>
          reject(
            new SyncTransportError(
              'AUTH_REQUIRED',
              `Google sign-in was cancelled or blocked: ${err.message ?? err.type ?? 'unknown'}`,
            ),
          ),
      });
      client.requestAccessToken({ prompt: '' });
    });
    if (resp.error || !resp.access_token) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        `Google sign-in failed: ${resp.error_description ?? resp.error ?? 'no access token'}`,
      );
    }
    const expiresInSec = Number(resp.expires_in) > 0 ? Number(resp.expires_in) : 3600;
    const existing = await this.storage.getKv<StoredOAuthTokens>(OAUTH_TOKENS_KV_KEY);
    const expiresAt = this.nowMs() + expiresInSec * 1000;
    const scope = resp.scope ?? existing?.scope;
    const stored: StoredOAuthTokens = {
      accessToken: resp.access_token,
      // A refresh token that was revoked stays useless; drop it so we don't retry it forever.
      refreshToken: existing && !existing.reconnectRequired ? existing.refreshToken : null,
      expiresAt,
      reconnectRequired: false,
      ...(scope !== undefined ? { scope } : {}),
    };
    await this.storage.setKv(OAUTH_TOKENS_KV_KEY, stored);
    return {
      provider: 'google',
      accessToken: resp.access_token,
      expiresAt,
      ...(scope !== undefined ? { scope } : {}),
      ...(opts?.intent !== undefined ? { intent: opts.intent } : {}),
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

  private getRedirectUri(): string {
    const win = this.getWindow();
    return `${win.location.origin}${win.location.pathname}`;
  }

  private async createPkcePair(): Promise<{ verifier: string; challenge: string }> {
    const win = this.getWindow();
    const verifierBytes = new Uint8Array(32);
    win.crypto.getRandomValues(verifierBytes);
    const verifier = base64UrlEncode(verifierBytes);
    const digest = await win.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64UrlEncode(new Uint8Array(digest));
    return { verifier, challenge };
  }

  async isConnected(): Promise<boolean> {
    const tokens = await this.storage.getKv<StoredOAuthTokens>(OAUTH_TOKENS_KV_KEY);
    if (!tokens || tokens.reconnectRequired) return false;
    return Boolean(tokens.refreshToken || (tokens.accessToken && tokens.expiresAt > this.nowMs()));
  }

  async getSession(): Promise<AuthSession | null> {
    const tokens = await this.storage.getKv<StoredOAuthTokens>(OAUTH_TOKENS_KV_KEY);
    if (!tokens || tokens.reconnectRequired || !tokens.accessToken) return null;
    return {
      provider: 'google',
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
    };
  }

  async signIn(opts?: { intent?: OAuthSignInIntent }): Promise<AuthSession | null> {
    if (!this.isConfigured()) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Google Drive sync is not configured (missing client ID).',
      );
    }
    if (await this.needsInteractiveRenew()) {
      return this.renewInteractively(opts);
    }

    const win = this.getWindow();
    const { verifier, challenge } = await this.createPkcePair();
    const stateBytes = new Uint8Array(16);
    win.crypto.getRandomValues(stateBytes);
    const state = base64UrlEncode(stateBytes);
    const redirectUri = this.getRedirectUri();

    // Preserve non-OAuth query parameters (such as `?device=a`) across the redirect round-trip
    const existingParams = new URLSearchParams(win.location.search);
    for (const k of ['code', 'state', 'scope', 'authuser', 'prompt', 'error']) {
      existingParams.delete(k);
    }
    const cleanSearch = existingParams.toString();
    const returnSearch = cleanSearch ? `?${cleanSearch}` : '';

    const pkce: StoredPkce = {
      verifier,
      state,
      redirectUri,
      returnSearch,
      createdAt: this.nowMs(),
      ...(opts?.intent !== undefined ? { intent: opts.intent } : {}),
    };
    await this.storage.setKv(OAUTH_PKCE_KV_KEY, pkce);

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_OAUTH_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });

    win.location.assign(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`);
    return null;
  }

  async handleRedirectCallback(): Promise<AuthSession | null> {
    const win = this.windowImpl;
    if (!win) return null;

    const params = new URLSearchParams(win.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');
    if (!code && !error) {
      return null;
    }

    const pkce = await this.storage.getKv<StoredPkce>(OAUTH_PKCE_KV_KEY);

    // Strip OAuth query parameters immediately via history.replaceState
    const cleanedParams = new URLSearchParams(win.location.search);
    for (const k of ['code', 'state', 'scope', 'authuser', 'prompt', 'error']) {
      cleanedParams.delete(k);
    }
    const fallbackSearch = cleanedParams.toString() ? `?${cleanedParams.toString()}` : '';
    const finalSearch = pkce?.returnSearch || fallbackSearch;
    win.history.replaceState(
      {},
      win.document?.title ?? '',
      `${win.location.origin}${win.location.pathname}${finalSearch}`,
    );

    if (error) {
      await this.storage.deleteKv(OAUTH_PKCE_KV_KEY);
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        `Google sign-in was cancelled or failed: ${error}`,
      );
    }

    if (!pkce || !state || pkce.state !== state) {
      await this.storage.deleteKv(OAUTH_PKCE_KV_KEY);
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'OAuth state verification failed. Please try connecting Google Drive again.',
      );
    }

    if (!this.clientId || !this.tokenHelperUrl) {
      await this.storage.deleteKv(OAUTH_PKCE_KV_KEY);
      throw new SyncTransportError('AUTH_REQUIRED', 'Missing token helper configuration.');
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.tokenHelperUrl}/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          redirect_uri: pkce.redirectUri,
          code_verifier: pkce.verifier,
        }),
      });
    } catch (err) {
      throw new SyncTransportError(
        'NETWORK',
        `Unable to reach token helper during sign-in: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await this.storage.deleteKv(OAUTH_PKCE_KV_KEY);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      const codeKind = res.status >= 500 ? 'NETWORK' : 'AUTH_REQUIRED';
      const detail =
        typeof data['error_description'] === 'string'
          ? data['error_description']
          : typeof data['error'] === 'string'
            ? data['error']
            : `HTTP ${res.status}`;
      throw new SyncTransportError(codeKind, `Google token exchange failed: ${detail}`, res.status);
    }

    const accessToken = typeof data['access_token'] === 'string' ? data['access_token'] : '';
    if (!accessToken) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Token exchange response missing access_token.',
      );
    }

    const existing = await this.storage.getKv<StoredOAuthTokens>(OAUTH_TOKENS_KV_KEY);
    const refreshToken =
      typeof data['refresh_token'] === 'string' && data['refresh_token']
        ? data['refresh_token']
        : (existing?.refreshToken ?? null);
    const expiresInSec =
      typeof data['expires_in'] === 'number' && data['expires_in'] > 0 ? data['expires_in'] : 3600;
    const expiresAt = this.nowMs() + expiresInSec * 1000;
    const scope = typeof data['scope'] === 'string' ? data['scope'] : existing?.scope;

    const stored: StoredOAuthTokens = {
      accessToken,
      refreshToken,
      expiresAt,
      reconnectRequired: false,
      ...(scope !== undefined ? { scope } : {}),
    };
    await this.storage.setKv(OAUTH_TOKENS_KV_KEY, stored);

    return {
      provider: 'google',
      accessToken,
      expiresAt,
      ...(scope !== undefined ? { scope } : {}),
      ...(pkce.intent !== undefined ? { intent: pkce.intent } : {}),
    };
  }

  async getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    const tokens = await this.storage.getKv<StoredOAuthTokens>(OAUTH_TOKENS_KV_KEY);
    if (!tokens) {
      throw new SyncTransportError('AUTH_REQUIRED', 'Google Drive is not connected.');
    }
    if (tokens.reconnectRequired) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Google Drive session expired. Please reconnect in Settings.',
      );
    }

    const needsRefresh =
      Boolean(opts?.forceRefresh) ||
      !tokens.accessToken ||
      tokens.expiresAt - this.nowMs() <= REFRESH_MARGIN_MS;

    if (!needsRefresh) {
      return tokens.accessToken;
    }

    if (!tokens.refreshToken || !this.tokenHelperUrl) {
      if (tokens.accessToken && tokens.expiresAt > this.nowMs() && !opts?.forceRefresh) {
        return tokens.accessToken;
      }
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Google Drive access expired. Tap Reconnect to renew it.',
      );
    }

    // Deduplicate concurrent refresh calls
    if (!this.inFlightRefresh) {
      this.inFlightRefresh = this.performRefresh(tokens, Boolean(opts?.forceRefresh)).finally(
        () => {
          this.inFlightRefresh = null;
        },
      );
    }
    return this.inFlightRefresh;
  }

  private async performRefresh(tokens: StoredOAuthTokens, forced = false): Promise<string> {
    if (!this.tokenHelperUrl) {
      throw new SyncTransportError('AUTH_REQUIRED', 'Missing token helper URL.');
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.tokenHelperUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      });
    } catch (err) {
      if (!isProbablyOnline()) {
        // Offline: preserve stored refresh_token untouched for automatic retry on reconnect
        throw new SyncTransportError(
          'NETWORK',
          `Token refresh failed (offline): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return this.onTokenHelperUnavailable(tokens, 'unreachable', forced);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      const errCode = typeof data['error'] === 'string' ? data['error'] : '';
      if (res.status === 429) {
        throw new SyncTransportError(
          'RATE_LIMITED',
          `Token refresh temporarily unavailable (HTTP ${res.status}).`,
          res.status,
        );
      }
      if (res.status >= 500 || res.status === 404) {
        // Worker down or gone: keep refresh_token intact and offer GIS tap-to-renew
        return this.onTokenHelperUnavailable(tokens, `HTTP ${res.status}`, forced);
      }

      if (res.status === 400 || res.status === 401 || errCode === 'invalid_grant') {
        // Revoked / expired refresh token: clear invalid access token & mark reconnect required
        await this.storage.setKv(OAUTH_TOKENS_KV_KEY, {
          ...tokens,
          accessToken: '',
          expiresAt: 0,
          reconnectRequired: true,
        } satisfies StoredOAuthTokens);
        throw new SyncTransportError(
          'AUTH_REQUIRED',
          'Google Drive session was revoked or expired. Please reconnect in Settings.',
          res.status,
        );
      }

      throw new SyncTransportError(
        'UNKNOWN',
        `Token refresh failed (HTTP ${res.status}): ${errCode || 'unknown_error'}`,
        res.status,
      );
    }

    const accessToken = typeof data['access_token'] === 'string' ? data['access_token'] : '';
    if (!accessToken) {
      throw new SyncTransportError('AUTH_REQUIRED', 'Token refresh response missing access_token.');
    }

    const expiresInSec =
      typeof data['expires_in'] === 'number' && data['expires_in'] > 0 ? data['expires_in'] : 3600;
    const updated: StoredOAuthTokens = {
      accessToken,
      refreshToken:
        typeof data['refresh_token'] === 'string' && data['refresh_token']
          ? data['refresh_token']
          : tokens.refreshToken,
      expiresAt: this.nowMs() + expiresInSec * 1000,
      reconnectRequired: false,
      ...(typeof data['scope'] === 'string'
        ? { scope: data['scope'] }
        : tokens.scope !== undefined
          ? { scope: tokens.scope }
          : {}),
    };
    await this.storage.setKv(OAUTH_TOKENS_KV_KEY, updated);
    await this.storage.deleteKv(OAUTH_HELPER_DOWN_KV_KEY);
    return accessToken;
  }

  /**
   * The token helper can't refresh (unreachable while online, 5xx or 404). Use the current
   * access token while it lasts; after that, ask for a GIS tap instead of a full re-login.
   */
  private async onTokenHelperUnavailable(
    tokens: StoredOAuthTokens,
    reason: string,
    forced: boolean,
  ): Promise<string> {
    await this.storage.setKv(OAUTH_HELPER_DOWN_KV_KEY, { since: this.nowMs(), reason });
    void loadGis().catch(() => {});
    const stillValid = Boolean(tokens.accessToken) && tokens.expiresAt > this.nowMs();
    if (stillValid && !forced) {
      return tokens.accessToken;
    }
    if (stillValid) {
      // A forced refresh means the server rejected this token; retry the helper later.
      throw new SyncTransportError(
        'NETWORK',
        `Token refresh failed: token helper unavailable (${reason}).`,
      );
    }
    throw new SyncTransportError(
      'AUTH_REQUIRED',
      `Google token helper is unavailable (${reason}). Tap Reconnect to renew access with Google directly.`,
    );
  }

  async signOut(): Promise<void> {
    this.inFlightRefresh = null;
    await this.storage.deleteKv(OAUTH_TOKENS_KV_KEY);
    await this.storage.deleteKv(OAUTH_PKCE_KV_KEY);
    await this.storage.deleteKv(OAUTH_HELPER_DOWN_KV_KEY);
  }
}
