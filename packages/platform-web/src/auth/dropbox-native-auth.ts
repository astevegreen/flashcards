import { SyncTransportError } from '@flash/core';
import type { Auth, AuthSession, OAuthSignInIntent, Storage } from '@flash/platform';
import { DROPBOX_NATIVE_SESSION_KV_KEY } from './dropbox-native-session-key.ts';

/** Tokens returned by a native Dropbox public-client sign-in or refresh. */
export interface DropboxTokenSet {
  accessToken: string;
  expiresInSeconds: number;
}

/**
 * Native Dropbox public client (authorization code + PKCE in the system browser; no client secret).
 * The bridge owns the refresh token (Keychain/Keystore on Capacitor, OS keychain on Tauri).
 */
export interface DropboxPublicClientBridge {
  authorize(): Promise<DropboxTokenSet>;
  refresh(): Promise<DropboxTokenSet>;
  signOut(): Promise<void>;
}

interface NativeDropboxSession {
  accessToken: string;
  expiresAt: number;
  reconnectRequired?: boolean;
}

/**
 * Thrown by a bridge when Dropbox rejects the stored refresh token (`invalid_grant`, revoked
 * consent, signed out). Any other bridge error counts as a transient network failure.
 */
export class DropboxRefreshRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DropboxRefreshRejectedError';
  }
}

function isRefreshRejected(err: unknown): boolean {
  return err instanceof Error && err.name === 'DropboxRefreshRejectedError';
}

const SESSION_KV_KEY = DROPBOX_NATIVE_SESSION_KV_KEY;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * `Auth` for Dropbox App Folder on native shells (PKCE public client with offline refresh tokens).
 * Caches the short-lived access token in storage (routed to Keychain/Keystore on Capacitor);
 * the refresh token stays with the bridge.
 */
export class NativeDropboxAuth implements Auth {
  private readonly bridge: DropboxPublicClientBridge | undefined;
  private readonly storage: Storage;
  private readonly nowMs: () => number;
  private inFlightRefresh: Promise<string> | null = null;

  constructor(options: {
    bridge?: DropboxPublicClientBridge;
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

  private async readSession(): Promise<NativeDropboxSession | undefined> {
    return this.storage.getKv<NativeDropboxSession>(SESSION_KV_KEY);
  }

  async isConnected(): Promise<boolean> {
    const session = await this.readSession();
    return Boolean(session && !session.reconnectRequired);
  }

  async getSession(): Promise<AuthSession | null> {
    const session = await this.readSession();
    if (!session || session.reconnectRequired) return null;
    return {
      provider: 'dropbox',
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
    };
  }

  private requireBridge(): DropboxPublicClientBridge {
    if (!this.bridge) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Dropbox sign-in is not configured in this build.',
      );
    }
    return this.bridge;
  }

  async signIn(opts?: { intent?: OAuthSignInIntent }): Promise<AuthSession | null> {
    const bridge = this.requireBridge();
    const tokens = await bridge.authorize();
    const session: NativeDropboxSession = {
      accessToken: tokens.accessToken,
      expiresAt: this.nowMs() + tokens.expiresInSeconds * 1000,
    };
    await this.storage.setKv(SESSION_KV_KEY, session);
    return {
      provider: 'dropbox',
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      ...(opts?.intent ? { intent: opts.intent } : {}),
    };
  }

  async handleRedirectCallback(): Promise<AuthSession | null> {
    // Native sign-in completes inside `signIn` (system browser + app scheme / loopback).
    return null;
  }

  async getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    const session = await this.readSession();
    if (!session) throw new SyncTransportError('AUTH_REQUIRED', 'Dropbox is not connected.');
    if (session.reconnectRequired) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        'Dropbox session expired. Please reconnect in Settings.',
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

  private async refresh(session: NativeDropboxSession): Promise<string> {
    const bridge = this.requireBridge();
    let tokens: DropboxTokenSet;
    try {
      tokens = await bridge.refresh();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (!isRefreshRejected(err)) {
        throw new SyncTransportError('NETWORK', `Dropbox refresh failed: ${detail}`);
      }
      await this.storage.setKv(SESSION_KV_KEY, { ...session, reconnectRequired: true });
      throw new SyncTransportError('AUTH_REQUIRED', `Dropbox session expired: ${detail}`);
    }
    await this.storage.setKv(SESSION_KV_KEY, {
      ...session,
      accessToken: tokens.accessToken,
      expiresAt: this.nowMs() + tokens.expiresInSeconds * 1000,
      reconnectRequired: false,
    } satisfies NativeDropboxSession);
    return tokens.accessToken;
  }

  async signOut(): Promise<void> {
    this.inFlightRefresh = null;
    if (this.bridge) await this.bridge.signOut().catch(() => undefined);
    await this.storage.deleteKv(SESSION_KV_KEY);
  }
}
