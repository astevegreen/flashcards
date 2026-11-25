import { SyncTransportError } from '@flash/core';
import type { Storage } from '@flash/platform';

/** Refresh this long before the cached access token expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The short-lived access token a native shell caches; the bridge keeps the refresh token. */
export interface NativeTokenSession {
  accessToken: string;
  expiresAt: number;
  reconnectRequired?: boolean;
}

/** Tokens returned by a native public-client sign-in or refresh. */
export interface NativeTokenSet {
  accessToken: string;
  expiresInSeconds: number;
}

/** The stored session, or AUTH_REQUIRED when there is none or it needs a new sign-in. */
export function requireNativeSession<S extends NativeTokenSession>(
  session: S | undefined,
  label: string,
): S {
  if (!session) throw new SyncTransportError('AUTH_REQUIRED', `${label} is not connected.`);
  if (session.reconnectRequired) {
    throw new SyncTransportError(
      'AUTH_REQUIRED',
      `${label} session expired. Please reconnect in Settings.`,
    );
  }
  return session;
}

/** True while the cached access token has more than the refresh margin left. */
export function isNativeTokenFresh(session: NativeTokenSession, nowMs: number): boolean {
  return session.expiresAt - nowMs > REFRESH_MARGIN_MS;
}

/**
 * Runs one bridge refresh and stores the new access token. Only an explicit rejection
 * (`isRejected`) marks the session for a new sign-in; offline blips throw NETWORK and retry later.
 */
export async function refreshNativeSession<S extends NativeTokenSession>(args: {
  label: string;
  session: S;
  storage: Storage;
  kvKey: string;
  nowMs: () => number;
  refresh: () => Promise<NativeTokenSet>;
  isRejected: (err: unknown) => boolean;
}): Promise<string> {
  const { label, session, storage, kvKey } = args;
  let tokens: NativeTokenSet;
  try {
    tokens = await args.refresh();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (!args.isRejected(err)) {
      throw new SyncTransportError('NETWORK', `${label} refresh failed: ${detail}`);
    }
    await storage.setKv(kvKey, { ...session, reconnectRequired: true });
    throw new SyncTransportError('AUTH_REQUIRED', `${label} session expired: ${detail}`);
  }
  await storage.setKv(kvKey, {
    ...session,
    accessToken: tokens.accessToken,
    expiresAt: args.nowMs() + tokens.expiresInSeconds * 1000,
    reconnectRequired: false,
  });
  return tokens.accessToken;
}
