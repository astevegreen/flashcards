import { SyncTransportError } from '@flash/core';

/**
 * The access-token policy shared by the Google, Dropbox and Microsoft web auths (R2): use the
 * stored token while it is fresh, otherwise refresh it, with one refresh in flight at a time.
 */

export interface RefreshableTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  reconnectRequired?: boolean;
}

export interface TokenRefresherOptions<T extends RefreshableTokens> {
  /** Names the service in errors ("Google Drive", "Dropbox", "OneDrive"). */
  label: string;
  /** Refresh this long before `expiresAt`. */
  marginMs: number;
  nowMs: () => number;
  read: () => Promise<T | undefined>;
  /** Fetches a new access token, stores it, and returns it. `forced` follows a 401. */
  refresh: (tokens: T, forced: boolean) => Promise<string>;
  /** Default: a refresh token is stored. */
  canRefresh?: (tokens: T) => boolean;
  /** The error when the token is stale and `canRefresh` is false. */
  cannotRefreshMessage: string;
  /** When it can't refresh, keep using a token that has not expired yet (unless forced). */
  useUnexpiredWhenUnrefreshable?: boolean;
}

/** The stored tokens after the provider rejected the refresh token: reconnect needed. */
export function reconnectRequiredTokens<T extends RefreshableTokens>(tokens: T): T {
  return { ...tokens, accessToken: '', expiresAt: 0, reconnectRequired: true };
}

/** Reads `access_token` from a token-endpoint reply, or fails: never store an empty token. */
export function requireAccessToken(data: Record<string, unknown>, label: string): string {
  const token = data['access_token'];
  if (typeof token === 'string' && token) return token;
  throw new SyncTransportError('AUTH_REQUIRED', `${label} refresh response missing access_token.`);
}

export class TokenRefresher<T extends RefreshableTokens> {
  private inFlight: Promise<string> | null = null;

  constructor(private readonly options: TokenRefresherOptions<T>) {}

  async getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    const o = this.options;
    const tokens = await o.read();
    if (!tokens) throw new SyncTransportError('AUTH_REQUIRED', `${o.label} is not connected.`);
    if (tokens.reconnectRequired) {
      throw new SyncTransportError(
        'AUTH_REQUIRED',
        `${o.label} session expired. Please reconnect in Settings.`,
      );
    }
    const forced = Boolean(opts?.forceRefresh);
    const now = o.nowMs();
    if (!forced && tokens.accessToken && tokens.expiresAt - now > o.marginMs) {
      return tokens.accessToken;
    }
    const canRefresh = o.canRefresh ? o.canRefresh(tokens) : Boolean(tokens.refreshToken);
    if (!canRefresh) {
      if (
        o.useUnexpiredWhenUnrefreshable &&
        !forced &&
        tokens.accessToken &&
        tokens.expiresAt > now
      ) {
        return tokens.accessToken;
      }
      throw new SyncTransportError('AUTH_REQUIRED', o.cannotRefreshMessage);
    }
    this.inFlight ??= o.refresh(tokens, forced).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Forgets a refresh in flight (sign-out). */
  reset(): void {
    this.inFlight = null;
  }
}
