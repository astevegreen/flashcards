import { SyncTransportError } from '@flash/core';
import type { Auth } from '@flash/platform';

/**
 * Shared bearer-token request policy for the cloud transports and pickers (R1): Google Drive,
 * Sheets and Docs, OneDrive / Graph, and Dropbox. A 401 refreshes the token once; 429 / 5xx retry
 * with exponential backoff + jitter, honoring `Retry-After`. A network failure becomes a
 * `SyncTransportError('NETWORK')`.
 */

const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 500;
/** A Retry-After longer than this fails the call (sync retries later) instead of hanging. */
const MAX_RETRY_AFTER_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface AuthorizedHttpClientOptions {
  auth: Pick<Auth, 'getValidAccessToken'>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Returns a value in [0, 1) for backoff jitter (injectable for deterministic tests). */
  random?: () => number;
  maxAttempts?: number;
  /** First backoff delay; doubles each attempt (default 500 ms). */
  baseDelayMs?: number;
  /**
   * Extra statuses to retry, on top of 429 / 5xx. Google reports throttling as 403 with a
   * rate-limit reason in the body (C22), so its clients pass {@link isGoogleRateLimited}.
   */
  isRetryable?: (res: Response) => boolean | Promise<boolean>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Parses `Retry-After` (delta-seconds or an HTTP date) into milliseconds. */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export class AuthorizedHttpClient {
  private readonly auth: Pick<Auth, 'getValidAccessToken'>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly isRetryable: ((res: Response) => boolean | Promise<boolean>) | undefined;

  /** `label` names the service in network-error messages ("OneDrive", "Dropbox"). */
  constructor(
    options: AuthorizedHttpClientOptions,
    private readonly label: string,
  ) {
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.baseDelayMs = options.baseDelayMs ?? BASE_RETRY_DELAY_MS;
    this.isRetryable = options.isRetryable;
  }

  private retryDelayMs(res: Response, attempt: number): number | null {
    const retryAfter = parseRetryAfterMs(res.headers.get('Retry-After'), Date.now());
    if (retryAfter !== null) return retryAfter <= MAX_RETRY_AFTER_MS ? retryAfter : null;
    const base = this.baseDelayMs * 2 ** attempt;
    return base + Math.floor(this.random() * base);
  }

  private async fetchOnce(url: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    try {
      return await this.fetchImpl(url, { ...init, headers });
    } catch (err) {
      throw new SyncTransportError(
        'NETWORK',
        `${this.label} network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async shouldRetry(res: Response): Promise<boolean> {
    if (RETRYABLE_STATUSES.has(res.status)) return true;
    return this.isRetryable ? this.isRetryable(res) : false;
  }

  /** Sends one request under the shared 401 / retry policy and returns the final response. */
  async send(url: string, init: RequestInit = {}, opts?: { withAuth: boolean }): Promise<Response> {
    const withAuth = opts?.withAuth ?? true;
    let token = withAuth ? await this.auth.getValidAccessToken() : '';
    let refreshed = false;
    // The one 401 refresh is not a retry attempt: only 429 / 5xx backoffs count.
    for (let attempt = 0; ;) {
      const res = await this.fetchOnce(url, init, token);
      if (res.status === 401 && withAuth && !refreshed) {
        refreshed = true;
        token = await this.auth.getValidAccessToken({ forceRefresh: true });
        continue;
      }
      const delay =
        attempt + 1 < this.maxAttempts && (await this.shouldRetry(res))
          ? this.retryDelayMs(res, attempt)
          : null;
      if (delay === null) return res;
      await this.sleep(delay);
      attempt += 1;
    }
  }

  /** A pre-authenticated URL (upload session, download URL): never carries the bearer token. */
  sendUnauthenticated(url: string, init: RequestInit = {}): Promise<Response> {
    return this.send(url, init, { withAuth: false });
  }
}
