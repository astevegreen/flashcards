import type { Auth, AuthSession, OAuthSignInIntent, Storage } from '@flash/platform';

export interface NativeGoogleSignInPlugin {
  signIn(opts: { scopes: string[]; clientId?: string }): Promise<{
    accessToken: string;
    expiresInSeconds?: number;
    scope?: string;
    email?: string;
  }>;
  refreshToken(): Promise<{ accessToken: string; expiresInSeconds?: number }>;
  signOut(): Promise<void>;
}

const NATIVE_SESSION_KV_KEY = 'capacitor_google_session_v1';

/**
 * Native Capacitor Google Sign-In adapter (§4.3, §11, §15 Phase 8), with **no Cloudflare Worker
 * token helper**. The long-lived Google credential stays with the OS (Google Play services on
 * Android, the GoogleSignIn SDK's Keychain items on iOS); "refresh" is a silent sign-in. The
 * short-lived access token cached under `NATIVE_SESSION_KV_KEY` is one of `SECURE_KV_KEYS`, so the
 * native boot keeps it in the Keychain / Keystore rather than SQLite.
 */
export class CapacitorGoogleAuth implements Auth {
  private readonly plugin?: NativeGoogleSignInPlugin;
  private readonly storage: Storage;
  private readonly clientId?: string;
  private readonly scopes: string[];

  constructor(options: {
    storage: Storage;
    plugin?: NativeGoogleSignInPlugin;
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
    return Boolean(this.plugin);
  }

  async isConnected(): Promise<boolean> {
    return (await this.getSession()) !== null;
  }

  async getSession(): Promise<AuthSession | null> {
    const saved = await this.storage.getKv<AuthSession>(NATIVE_SESSION_KV_KEY);
    return saved ?? null;
  }

  async getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    const session = await this.getSession();
    const now = Date.now();
    if (session && !opts?.forceRefresh && session.expiresAt - now > 60_000) {
      return session.accessToken;
    }
    if (!this.plugin) {
      throw new Error('Native Google Sign-In plugin is unavailable.');
    }
    const refreshed = await this.plugin.refreshToken();
    const next: AuthSession = {
      provider: 'google-native',
      accessToken: refreshed.accessToken,
      expiresAt: now + (refreshed.expiresInSeconds ?? 3500) * 1000,
      ...(session?.scope ? { scope: session.scope } : {}),
      ...(session?.intent ? { intent: session.intent } : {}),
    };
    await this.storage.setKv(NATIVE_SESSION_KV_KEY, next);
    return next.accessToken;
  }

  async signIn(opts?: { intent?: OAuthSignInIntent }): Promise<AuthSession | null> {
    if (!this.plugin) {
      throw new Error('Native Google Sign-In plugin is unavailable.');
    }
    const res = await this.plugin.signIn({
      scopes: this.scopes,
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
    const session: AuthSession = {
      provider: 'google-native',
      accessToken: res.accessToken,
      expiresAt: Date.now() + (res.expiresInSeconds ?? 3500) * 1000,
      ...(res.scope ? { scope: res.scope } : {}),
      ...(opts?.intent ? { intent: opts.intent } : {}),
    };
    await this.storage.setKv(NATIVE_SESSION_KV_KEY, session);
    return session;
  }

  async handleRedirectCallback(): Promise<AuthSession | null> {
    // Native Google Sign-In resolves inline without browser redirect callbacks
    return this.getSession();
  }

  async signOut(): Promise<void> {
    if (this.plugin) {
      try {
        await this.plugin.signOut();
      } catch {
        // Ignore signOut errors if already signed out
      }
    }
    await this.storage.deleteKv(NATIVE_SESSION_KV_KEY);
  }
}
