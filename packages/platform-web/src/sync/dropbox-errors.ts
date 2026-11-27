import { SyncTransportError, type SyncTransportErrorCode } from '@flash/core';

/**
 * Maps a Dropbox HTTP failure to the `SyncTransport` error contract. Dropbox reports most
 * path errors as 409 with an `error_summary` such as `path/not_found/..` or `path/conflict/file/..`,
 * so the summary decides between NOT_FOUND, ALREADY_EXISTS and a real failure (for example
 * `path/insufficient_space`, which must never pass as a successful write).
 */
function codeForDropboxStatus(status: number, errorSummary?: string): SyncTransportErrorCode {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) {
    if (errorSummary?.includes('not_found')) return 'NOT_FOUND';
    if (errorSummary?.startsWith('path/conflict')) return 'ALREADY_EXISTS';
    return 'UNKNOWN';
  }
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'NETWORK';
  return 'UNKNOWN';
}

export async function dropboxFailure(res: Response, action: string): Promise<SyncTransportError> {
  let summary: string | undefined;
  try {
    const raw = (await res.json()) as { error_summary?: unknown; error?: unknown };
    if (typeof raw.error_summary === 'string' && raw.error_summary) {
      summary = raw.error_summary;
    } else if (typeof raw.error === 'string' && raw.error) {
      summary = raw.error;
    }
  } catch {
    // non-JSON error body
  }
  const detail = summary ?? `HTTP ${res.status}`;
  return new SyncTransportError(
    codeForDropboxStatus(res.status, summary),
    `Dropbox ${action} failed: ${detail}`,
    res.status,
  );
}
