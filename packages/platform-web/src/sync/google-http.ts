import { SyncTransportError } from '@flash/core';
import type { Auth } from '@flash/platform';
import { AuthorizedHttpClient } from './authorized-http.ts';
import { isGoogleRateLimited } from './google-errors.ts';

/**
 * Google API requests (Drive appData sync, Sheets, Docs, plain Drive files) on the shared
 * {@link AuthorizedHttpClient} policy, plus Google's error mapping: a 403 rate limit is
 * RATE_LIMITED, never PERMISSION_DENIED (C22).
 */

export interface GoogleFetchOptions {
  auth: Pick<Auth, 'getValidAccessToken'>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Longest `Retry-After` to wait (default 30 s, for background sync). */
  maxRetryAfterMs?: number;
  /** Names the service in network errors ("Google Drive", "Google API"). */
  label: string;
  messages: {
    authRequired: string;
    permissionDenied: string;
    /** When set, a 404 throws NOT_FOUND with this message; otherwise it is returned. */
    notFound?: string;
  };
}

export type GoogleFetch = (url: string, init?: RequestInit) => Promise<Response>;

const GOOGLE_MAX_ATTEMPTS = 3;
const GOOGLE_BASE_DELAY_MS = 250;

export function createGoogleFetch(options: GoogleFetchOptions): GoogleFetch {
  const client = new AuthorizedHttpClient(
    {
      auth: options.auth,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.random ? { random: options.random } : {}),
      ...(options.maxRetryAfterMs === undefined
        ? {}
        : { maxRetryAfterMs: options.maxRetryAfterMs }),
      maxAttempts: GOOGLE_MAX_ATTEMPTS,
      baseDelayMs: GOOGLE_BASE_DELAY_MS,
      isRetryable: isGoogleRateLimited,
    },
    options.label,
  );
  const { label, messages } = options;
  return async (url, init = {}) => {
    const res = await client.send(url, init);
    if (res.status === 401)
      throw new SyncTransportError('AUTH_REQUIRED', messages.authRequired, 401);
    if (await isGoogleRateLimited(res)) {
      throw new SyncTransportError('RATE_LIMITED', `${label} rate limit exceeded.`, res.status);
    }
    if (res.status === 404 && messages.notFound) {
      throw new SyncTransportError('NOT_FOUND', messages.notFound, 404);
    }
    if (res.status === 403) {
      throw new SyncTransportError('PERMISSION_DENIED', messages.permissionDenied, 403);
    }
    if (res.status >= 500) {
      throw new SyncTransportError(
        'NETWORK',
        `${label} server error (HTTP ${res.status}).`,
        res.status,
      );
    }
    return res;
  };
}
