import { SyncTransportError } from '@flash/core';
import type { Storage } from '@flash/platform';
import { TokenRefresher } from './token-refresher.ts';

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

/**
 * The shared `TokenRefresher` (R2) for a native auth: the cached session is used while fresh,
 * otherwise one bridge refresh runs at a time. Without a bridge, a stale token can't be refreshed.
 */
export function createNativeTokenRefresher<S extends NativeTokenSession>(args: {
  label: string;
  storage: Storage;
  kvKey: string;
  nowMs: () => number;
  hasBridge: () => boolean;
  refresh: (session: S) => Promise<NativeTokenSet>;
  isRejected: (err: unknown) => boolean;
}): TokenRefresher<S> {
  return new TokenRefresher<S>({
    label: args.label,
    marginMs: REFRESH_MARGIN_MS,
    nowMs: args.nowMs,
    read: () => args.storage.getKv<S>(args.kvKey),
    canRefresh: args.hasBridge,
    cannotRefreshMessage: `${args.label} sign-in is not configured in this build.`,
    refresh: (session) =>
      refreshNativeSession({
        label: args.label,
        session,
        storage: args.storage,
        kvKey: args.kvKey,
        nowMs: args.nowMs,
        refresh: () => args.refresh(session),
        isRejected: args.isRejected,
      }),
  });
}
