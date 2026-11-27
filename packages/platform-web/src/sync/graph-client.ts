import type { SyncTransportErrorCode } from '@flash/core';
import { AuthorizedHttpClient, type AuthorizedHttpClientOptions } from './authorized-http.ts';

/**
 * Microsoft Graph client for the OneDrive transport and picker (§15 Phase 12), on the shared
 * `AuthorizedHttpClient` policy: a 401 refreshes the token once; 429 / 5xx retry with backoff.
 * Pre-authenticated upload/download URLs are sent without the bearer token.
 */

export { parseRetryAfterMs } from './authorized-http.ts';

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphDriveItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  eTag?: string;
  cTag?: string;
  webUrl?: string;
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

export interface GraphClientOptions extends AuthorizedHttpClientOptions {
  /** Graph base URL (default `https://graph.microsoft.com/v1.0`). */
  graphBaseUrl?: string;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
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

export class GraphClient extends AuthorizedHttpClient {
  readonly base: string;

  constructor(options: GraphClientOptions) {
    super(options, 'OneDrive');
    this.base = stripTrailingSlashes(options.graphBaseUrl ?? GRAPH_API_BASE);
  }
}
