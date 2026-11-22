import type { Auth, AuthSession, OAuthSignInIntent, Storage } from '@flash/platform';

export interface TauriLoopbackOAuthPlugin {
  authorizeWithSystemBrowser(opts: {
    clientId: string;
    scopes: string[];
  }): Promise<{ accessToken: string; expiresInSeconds: number; scope?: string }>;
  refreshAccessToken(): Promise<{ accessToken: string; expiresInSeconds: number }>;
  revokeSession(): Promise<void>;
}

const TAURI_SESSION_KV_KEY = 'tauri_google_session_v1';

/**
 * Native desktop loopback Google Sign-In adapter for Tauri PC builds (§4.3, §11, §15 Phase 8).
 * Uses desktop loopback redirect (`127.0.0.1`) + OS keychain with zero Cloudflare Worker needed.
 */
export class TauriGoogleAuth implements Auth {
  private readonly storage: Storage;
  private readonly plugin?: TauriLoopbackOAuthPlugin;
  private readonly clientId?: string;
  private readonly scopes: string[];

  constructor(options: {
    storage: Storage;
    plugin?: TauriLoopbackOAuthPlugin;
    clientId?: string;
    scopes?: string[];
  }) {
    this.storage = options.storage;
    if (options.plugin) this.plugin = options.plugin;
    if (options.clientId) this.clientId = options.clientId;
    this.scopes = options.scopes ?? [
      'https://www.googleapis.com/auth/drive.appdata',
      'https://www.googleapis.com/auth/drive.file',
    ];
  }

  isConfigured(): boolean {
    return Boolean(this.plugin && this.clientId);
  }

  async isConnected(): Promise<boolean> {
    return (await this.getSession()) !== null;
  }

  async getSession(): Promise<AuthSession | null> {
    return (await this.storage.getKv<AuthSession>(TAURI_SESSION_KV_KEY)) ?? null;
  }

  async getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    const existing = await this.getSession();
    const now = Date.now();
    if (existing && !opts?.forceRefresh && existing.expiresAt - now > 60_000) {
      return existing.accessToken;
    }
    if (!this.plugin) throw new Error('Tauri loopback OAuth plugin unavailable.');
    const refreshed = await this.plugin.refreshAccessToken();
    const next: AuthSession = {
      provider: 'google-tauri',
      accessToken: refreshed.accessToken,
      expiresAt: now + refreshed.expiresInSeconds * 1000,
      ...(existing?.scope ? { scope: existing.scope } : {}),
      ...(existing?.intent ? { intent: existing.intent } : {}),
    };
    await this.storage.setKv(TAURI_SESSION_KV_KEY, next);
    return next.accessToken;
  }

  async signIn(opts?: { intent?: OAuthSignInIntent }): Promise<AuthSession | null> {
    if (!this.plugin || !this.clientId) {
      throw new Error('Tauri Google OAuth is not configured.');
    }
    const res = await this.plugin.authorizeWithSystemBrowser({
      clientId: this.clientId,
      scopes: this.scopes,
    });
    const session: AuthSession = {
      provider: 'google-tauri',
      accessToken: res.accessToken,
      expiresAt: Date.now() + res.expiresInSeconds * 1000,
      ...(res.scope ? { scope: res.scope } : {}),
      ...(opts?.intent ? { intent: opts.intent } : {}),
    };
    await this.storage.setKv(TAURI_SESSION_KV_KEY, session);
    return session;
  }

  async handleRedirectCallback(): Promise<AuthSession | null> {
    return this.getSession();
  }

  async signOut(): Promise<void> {
    if (this.plugin) {
      try {
        await this.plugin.revokeSession();
      } catch {
        // Ignore revoke errors
      }
    }
    await this.storage.deleteKv(TAURI_SESSION_KV_KEY);
  }
}
