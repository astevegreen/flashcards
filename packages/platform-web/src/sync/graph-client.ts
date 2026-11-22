import { SyncTransportError, type SyncTransportErrorCode } from '@flash/core';
import type { Auth } from '@flash/platform';

/**
 * Shared Microsoft Graph request policy for the OneDrive transport and picker (§15 Phase 12):
 * a 401 refreshes the token once; 429 / 5xx retry with exponential backoff + jitter, honoring
 * `Retry-After`. Pre-authenticated upload/download URLs are sent without the bearer token.
 */

export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 500;
/** A Retry-After longer than this fails the call (sync retries later) instead of hanging. */
const MAX_RETRY_AFTER_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface GraphDriveItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  '@microsoft.graph.downloadUrl'?: string;
}

export interface GraphChildrenPage {
  value?: GraphDriveItem[];
  '@odata.nextLink'?: string;
}

interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

export interface GraphClientOptions {
  auth: Pick<Auth, 'getValidAccessToken'>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Returns a value in [0, 1) for backoff jitter (injectable for deterministic tests). */
  random?: () => number;
  /** Graph base URL (default `https://graph.microsoft.com/v1.0`). */
  graphBaseUrl?: string;
  maxAttempts?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/** Parses `Retry-After` (delta-seconds or an HTTP date) into milliseconds. */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export async function readGraphError(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json().catch(() => null)) as GraphErrorBody | null;
  return {
    code: body?.error?.code ?? '',
    message: body?.error?.message ?? `HTTP ${res.status}`,
  };
}

export function codeForGraphStatus(status: number): SyncTransportErrorCode {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'NETWORK';
  return 'UNKNOWN';
}

export class GraphClient {
  readonly base: string;
  private readonly auth: Pick<Auth, 'getValidAccessToken'>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;

  constructor(options: GraphClientOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.base = stripTrailingSlashes(options.graphBaseUrl ?? GRAPH_API_BASE);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  }

  private retryDelayMs(res: Response, attempt: number): number | null {
    const retryAfter = parseRetryAfterMs(res.headers.get('Retry-After'), Date.now());
    if (retryAfter !== null) return retryAfter <= MAX_RETRY_AFTER_MS ? retryAfter : null;
    const base = BASE_RETRY_DELAY_MS * 2 ** attempt;
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
        `OneDrive network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Sends one request under the shared 401 / retry policy and returns the final response. */
  async send(url: string, init: RequestInit = {}, opts?: { withAuth: boolean }): Promise<Response> {
    const withAuth = opts?.withAuth ?? true;
    let token = withAuth ? await this.auth.getValidAccessToken() : '';
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.fetchOnce(url, init, token);
      if (res.status === 401 && withAuth && !refreshed) {
        refreshed = true;
        token = await this.auth.getValidAccessToken({ forceRefresh: true });
        continue;
      }
      const delay =
        RETRYABLE_STATUSES.has(res.status) && attempt + 1 < this.maxAttempts
          ? this.retryDelayMs(res, attempt)
          : null;
      if (delay === null) return res;
      await this.sleep(delay);
    }
  }

  /** A pre-authenticated URL (upload session, download URL): never carries the bearer token. */
  sendUnauthenticated(url: string, init: RequestInit = {}): Promise<Response> {
    return this.send(url, init, { withAuth: false });
  }
}
