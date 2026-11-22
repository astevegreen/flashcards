import { SyncTransportError } from '@flash/core';
import type { Auth, AuthSession, OAuthSignInIntent, Storage } from '@flash/platform';
import { MICROSOFT_PICKER_SCOPE, MICROSOFT_SYNC_SCOPES } from './microsoft-oauth-web.ts';

/** Tokens returned by a native Microsoft public-client sign-in or refresh. */
export interface MicrosoftTokenSet {
  accessToken: string;
  expiresInSeconds: number;
}

/**
 * Native Microsoft identity platform public client (authorization code + PKCE in the system
 * browser; no client secret). The bridge owns the refresh token: Tauri keeps it in the OS
 * keychain, Capacitor in the sign-in plugin's own store. `refresh` redeems that stored token.
 */
export interface MicrosoftPublicClientBridge {
  authorize(scopes: readonly string[]): Promise<MicrosoftTokenSet>;
  refresh(scopes: readonly string[]): Promise<MicrosoftTokenSet>;
  signOut(): Promise<void>;
}

interface NativeMicrosoftSession {
  accessToken: string;
  expiresAt: number;
  /** Space-separated scopes the user consented to. */
  scope: string;
  reconnectRequired?: boolean;
}

/**
 * Thrown by a bridge when Microsoft rejects the stored refresh token (`invalid_grant`, revoked
 * consent, signed out). Any other bridge error counts as a transient network failure.
 */
export class MicrosoftRefreshRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrosoftRefreshRejectedError';
  }
}

function isRefreshRejected(err: unknown): boolean {
  return err instanceof Error && err.name === 'MicrosoftRefreshRejectedError';
}

const SESSION_KV_KEY = 'onedrive_native_session_v1';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function scopeList(scope: string): string[] {
  return scope.split(' ').filter((s) => s.length > 0);
}

/**
 * `Auth` for OneDrive on native shells (§4.3: "native shells use public clients with rolling
 * refresh tokens"; no token helper). Caches the short-lived access token and granted scopes in
 * the app database; the refresh token stays with the bridge.
 */
export class NativeMicrosoftAuth implements Auth {
  private readonly bridge: MicrosoftPublicClientBridge | undefined;
  private readonly storage: Storage;
  private readonly nowMs: () => number;
  private inFlightRefresh: Promise<string> | null = null;

  constructor(options: {
    bridge?: MicrosoftPublicClientBridge;
    storage: Storage;
    nowMs?: () => number;
  }) {
    this.bridge = options.bridge;
    this.storage = options.storage;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return this.bridge !== undefined;
  }

  private async readSession(): Promise<NativeMicrosoftSession | undefined> {
    return this.storage.getKv<NativeMicrosoftSession>(SESSION_KV_KEY);
  }

  async isConnected(): Promise<boolean> {
    const session = await this.readSession();
    return Boolean(session && !session.reconnectRequired);
  }

  async hasScope(scope: string): Promise<boolean> {
    const session = await this.readSession();
    return Boolean(
      session && !session.reconnectRequired && scopeList(session.scope).includes(scope),
    );
  }

  async getSession(): Promise<AuthSession | null> {
    const session = await this.readSession();
    if (!session || session.reconnectRequired) return null;
    return {
      provider: 'onedrive',
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      scope: session.scope,
    };
  }

  private requireBridge(): MicrosoftPublicClientBridge {
    if (!this.bridge) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'OneDrive sign-in is not configured in this build.',
      );
    }
    return this.bridge;
  }

  async signIn(opts?: { intent?: OAuthSignInIntent }): Promise<AuthSession | null> {
    const bridge = this.requireBridge();
    const existing = await this.readSession();
    const scopes = new Set<string>([
      ...MICROSOFT_SYNC_SCOPES,
      ...(existing && !existing.reconnectRequired ? scopeList(existing.scope) : []),
      ...(opts?.intent === 'sources' ? [MICROSOFT_PICKER_SCOPE] : []),
    ]);
    const tokens = await bridge.authorize([...scopes]);
    const session: NativeMicrosoftSession = {
      accessToken: tokens.accessToken,
      expiresAt: this.nowMs() + tokens.expiresInSeconds * 1000,
      scope: [...scopes].join(' '),
    };
    await this.storage.setKv(SESSION_KV_KEY, session);
    return {
      provider: 'onedrive',
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      scope: session.scope,
      ...(opts?.intent ? { intent: opts.intent } : {}),
    };
  }

  async handleRedirectCallback(): Promise<AuthSession | null> {
    // Native sign-in completes inside `signIn` (system browser + loopback / app scheme).
    return null;
  }

  async getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    const session = await this.readSession();
    if (!session) throw new SyncTransportError('AUTH_REQUIRED', 'OneDrive is not connected.');
    if (session.reconnectRequired) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'OneDrive session expired. Please reconnect in Settings.',
      );
    }
    if (!opts?.forceRefresh && session.expiresAt - this.nowMs() > REFRESH_MARGIN_MS) {
      return session.accessToken;
    }
    this.inFlightRefresh ??= this.refresh(session).finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async refresh(session: NativeMicrosoftSession): Promise<string> {
    const bridge = this.requireBridge();
    let tokens: MicrosoftTokenSet;
    try {
      tokens = await bridge.refresh(scopeList(session.scope));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Only an explicit rejection forces a new sign-in; offline blips just retry later.
      if (!isRefreshRejected(err)) {
        throw new SyncTransportError('NETWORK', `OneDrive refresh failed: ${detail}`);
      }
      await this.storage.setKv(SESSION_KV_KEY, { ...session, reconnectRequired: true });
      throw new SyncTransportError('AUTH_REQUIRED', `OneDrive session expired: ${detail}`);
    }
    await this.storage.setKv(SESSION_KV_KEY, {
      ...session,
      accessToken: tokens.accessToken,
      expiresAt: this.nowMs() + tokens.expiresInSeconds * 1000,
      reconnectRequired: false,
    } satisfies NativeMicrosoftSession);
    return tokens.accessToken;
  }

  async signOut(): Promise<void> {
    this.inFlightRefresh = null;
    if (this.bridge) await this.bridge.signOut().catch(() => undefined);
    await this.storage.deleteKv(SESSION_KV_KEY);
  }
}
