import {
  compareCodeUnits,
  hasDotSegment,
  hasTraversalSegment,
  SyncTransportError,
} from '@flash/core';
import type { Auth, SyncFileInfo, SyncTransport } from '@flash/platform';
import {
  codeForGraphStatus,
  GraphClient,
  readGraphError,
  type GraphChildrenPage,
  type GraphDriveItem,
} from './graph-client.ts';

export { GRAPH_API_BASE, parseRetryAfterMs } from './graph-client.ts';

/** Graph's documented limit for a single-request `PUT …/content` upload. */
export const ONEDRIVE_SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** Upload-session fragments must be a multiple of 320 KiB (Graph `createUploadSession`). */
export const ONEDRIVE_UPLOAD_CHUNK_UNIT = 320 * 1024;
const DEFAULT_CHUNK_BYTES = ONEDRIVE_UPLOAD_CHUNK_UNIT * 10; // 3.125 MiB per PUT
const LIST_PAGE_SIZE = 200;

export interface OneDriveTransportOptions {
  auth: Pick<Auth, 'getValidAccessToken'>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Returns a value in [0, 1) for backoff jitter (injectable for deterministic tests). */
  random?: () => number;
  /** Graph base URL (default `https://graph.microsoft.com/v1.0`). */
  graphBaseUrl?: string;
  /** Upload-session fragment size; rounded down to a multiple of 320 KiB. */
  chunkBytes?: number;
  maxAttempts?: number;
}

function stripLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === '/') start += 1;
  return value.slice(start);
}

/** Validates a logical sync path (`sync/v1/...`) and returns its segments. */
export function oneDrivePathSegments(path: string, allowEmpty = false): string[] {
  const clean = stripLeadingSlashes(path.replaceAll('\\', '/'));
  const segments = clean.split('/').filter((s) => s.length > 0);
  if (hasTraversalSegment(clean) || hasDotSegment(clean)) {
    throw new SyncTransportError('UNKNOWN', `Unsafe OneDrive sync path "${path}".`);
  }
  if (segments.length === 0 && !allowEmpty) {
    throw new SyncTransportError('UNKNOWN', `Empty OneDrive sync path "${path}".`);
  }
  return segments;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Maps a failed Graph response to the §4.3 `SyncTransportError` contract. */
async function toTransportError(
  res: Response,
  action: string,
  opts?: { ifAbsent?: boolean },
): Promise<SyncTransportError> {
  const { code, message } = await readGraphError(res);
  if (res.status === 409 && opts?.ifAbsent && code === 'nameAlreadyExists') {
    return new SyncTransportError(
      'ALREADY_EXISTS',
      `OneDrive write-once file already exists (${action}).`,
      409,
    );
  }
  if (res.status === 507) {
    return new SyncTransportError('UNKNOWN', 'Your OneDrive is full.', 507);
  }
  return new SyncTransportError(
    codeForGraphStatus(res.status),
    `OneDrive ${action} failed: ${message}`,
    res.status,
  );
}

/** First `start` offset of Graph's `nextExpectedRanges` (e.g. `["327680-"]`). */
/** Consecutive 202/416 responses that do not move the upload forward before giving up. */
const MAX_UPLOAD_STALLS = 3;

function nextExpectedOffset(body: unknown): number | null {
  const ranges = (body as { nextExpectedRanges?: unknown } | null)?.nextExpectedRanges;
  if (!Array.isArray(ranges) || typeof ranges[0] !== 'string') return null;
  const start = Number.parseInt(ranges[0].split('-')[0] ?? '', 10);
  return Number.isFinite(start) ? start : null;
}

/**
 * Microsoft OneDrive app-folder `SyncTransport` (§4.3, §15 Phase 12).
 *
 * Every `sync/v1/...` object lives at the same relative path under the app's private
 * `/me/drive/special/approot` folder (`Files.ReadWrite.AppFolder`). Write-once segments use
 * `@microsoft.graph.conflictBehavior=fail`, so a concurrent duplicate surfaces as
 * `ALREADY_EXISTS`; files over 4 MB go through a resumable upload session.
 */
export class OneDriveAppFolderTransport implements SyncTransport {
  private readonly client: GraphClient;
  private readonly chunkBytes: number;

  constructor(options: OneDriveTransportOptions) {
    this.client = new GraphClient(options);
    const requested = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.chunkBytes = Math.max(
      ONEDRIVE_UPLOAD_CHUNK_UNIT,
      Math.floor(requested / ONEDRIVE_UPLOAD_CHUNK_UNIT) * ONEDRIVE_UPLOAD_CHUNK_UNIT,
    );
  }

  /** `…/approot:/a/b:<suffix>` for a path, or `…/approot<suffix>` for the folder itself. */
  private itemUrl(segments: readonly string[], suffix = ''): string {
    const root = `${this.client.base}/me/drive/special/approot`;
    if (segments.length === 0) return `${root}${suffix}`;
    return `${root}:/${segments.map((s) => encodeURIComponent(s)).join('/')}:${suffix}`;
  }

  private graph(url: string, init: RequestInit = {}): Promise<Response> {
    return this.client.send(url, init);
  }

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const prefixSegments = oneDrivePathSegments(prefix, true);
    const normalizedPrefix = prefixSegments.join('/') + (prefix.endsWith('/') ? '/' : '');
    // Walk from the deepest complete folder of the prefix; the last segment may be partial.
    const startFolder = prefix.endsWith('/') ? prefixSegments : prefixSegments.slice(0, -1);
    const out: SyncFileInfo[] = [];
    await this.walk(startFolder, normalizedPrefix, out, true);
    return out.sort((a, b) => compareCodeUnits(a.path, b.path));
  }

  private async walk(
    folder: readonly string[],
    prefix: string,
    out: SyncFileInfo[],
    isStart: boolean,
  ): Promise<void> {
    const params = new URLSearchParams({
      $top: String(LIST_PAGE_SIZE),
      $select: 'id,name,size,lastModifiedDateTime,folder,file',
    });
    let url: string | undefined = `${this.itemUrl(folder, '/children')}?${params.toString()}`;
    while (url) {
      const res = await this.graph(url);
      // A missing start folder just means nothing was synced there yet.
      if (res.status === 404 && isStart) return;
      if (!res.ok) throw await toTransportError(res, 'list');
      const page = (await res.json()) as GraphChildrenPage;
      for (const item of page.value ?? []) {
        await this.collect(folder, item, prefix, out);
      }
      url = page['@odata.nextLink'];
    }
  }

  private async collect(
    folder: readonly string[],
    item: GraphDriveItem,
    prefix: string,
    out: SyncFileInfo[],
  ): Promise<void> {
    if (!item.name) return;
    const childSegments = [...folder, item.name];
    const childPath = childSegments.join('/');
    if (item.folder) {
      const asFolder = `${childPath}/`;
      if (asFolder.startsWith(prefix) || prefix.startsWith(asFolder)) {
        await this.walk(childSegments, prefix, out, false);
      }
      return;
    }
    if (!childPath.startsWith(prefix)) return;
    const updatedAt = item.lastModifiedDateTime
      ? Date.parse(item.lastModifiedDateTime)
      : Number.NaN;
    out.push({
      path: childPath,
      size: item.size ?? 0,
      ...(Number.isNaN(updatedAt) ? {} : { updatedAt }),
    });
  }

  async read(path: string): Promise<Uint8Array> {
    const segments = oneDrivePathSegments(path);
    // Item metadata carries a short-lived pre-authenticated download URL. Fetching it directly
    // (instead of following `/content`'s 302) avoids cross-origin redirect quirks in WebViews.
    const metaRes = await this.graph(this.itemUrl(segments));
    if (!metaRes.ok) throw await toTransportError(metaRes, `read "${path}"`);
    const item = (await metaRes.json()) as GraphDriveItem;
    if (item.folder) {
      throw new SyncTransportError('NOT_FOUND', `OneDrive path is a folder: "${path}"`, 404);
    }
    const downloadUrl = item['@microsoft.graph.downloadUrl'];
    const res = downloadUrl
      ? await this.client.sendUnauthenticated(downloadUrl)
      : await this.graph(this.itemUrl(segments, '/content'));
    if (!res.ok) throw await toTransportError(res, `download "${path}"`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    const segments = oneDrivePathSegments(path);
    const conflictBehavior = opts?.ifAbsent ? 'fail' : 'replace';
    if (data.byteLength <= ONEDRIVE_SIMPLE_UPLOAD_MAX_BYTES) {
      const params = new URLSearchParams({ '@microsoft.graph.conflictBehavior': conflictBehavior });
      const res = await this.graph(`${this.itemUrl(segments, '/content')}?${params.toString()}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: toArrayBuffer(data),
      });
      if (!res.ok) throw await toTransportError(res, `upload "${path}"`, opts);
      return;
    }
    await this.uploadLarge(segments, path, data, conflictBehavior, opts);
  }

  private async uploadLarge(
    segments: readonly string[],
    path: string,
    data: Uint8Array,
    conflictBehavior: 'fail' | 'replace',
    opts?: { ifAbsent?: boolean },
  ): Promise<void> {
    const sessionRes = await this.graph(this.itemUrl(segments, '/createUploadSession'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': conflictBehavior } }),
    });
    if (!sessionRes.ok) throw await toTransportError(sessionRes, `upload "${path}"`, opts);
    const session = (await sessionRes.json()) as { uploadUrl?: string };
    if (!session.uploadUrl) {
      throw new SyncTransportError('UNKNOWN', 'OneDrive upload session returned no uploadUrl.');
    }
    try {
      await this.uploadFragments(session.uploadUrl, path, data, opts);
    } catch (err) {
      // Best effort: free the server-side session so the partial upload is discarded.
      await this.client
        .sendUnauthenticated(session.uploadUrl, { method: 'DELETE' })
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * PUTs the fragments of an upload session. Only a 200/201 means the file was committed: a
   * session that runs past the last byte without one, cannot say where to resume, or stops
   * advancing throws, so the sync engine never writes a head pointing at a missing file.
   */
  private async uploadFragments(
    uploadUrl: string,
    path: string,
    data: Uint8Array,
    opts?: { ifAbsent?: boolean },
  ): Promise<void> {
    const total = data.byteLength;
    let offset = 0;
    let stalls = 0;
    while (offset < total) {
      const end = Math.min(offset + this.chunkBytes, total);
      const res = await this.client.sendUnauthenticated(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
        body: toArrayBuffer(data.subarray(offset, end)),
      });
      if (res.status === 200 || res.status === 201) return;
      const next = await this.nextFragmentOffset(res, uploadUrl, end, path, opts);
      stalls = next > offset ? 0 : stalls + 1;
      if (stalls > MAX_UPLOAD_STALLS) {
        throw new SyncTransportError(
          'UNKNOWN',
          `OneDrive upload session for "${path}" stopped advancing at byte ${offset}.`,
        );
      }
      offset = next;
    }
    throw new SyncTransportError(
      'UNKNOWN',
      `OneDrive upload session for "${path}" ended without completing.`,
    );
  }

  /** Where the next fragment starts after a non-final response (202 / 416), or throws. */
  private async nextFragmentOffset(
    res: Response,
    uploadUrl: string,
    end: number,
    path: string,
    opts?: { ifAbsent?: boolean },
  ): Promise<number> {
    if (res.status === 202) {
      return nextExpectedOffset(await res.json().catch(() => null)) ?? end;
    }
    if (res.status === 416) {
      // The fragment may already have landed (e.g. a retried PUT): ask the session where to resume.
      return this.resumeOffset(uploadUrl, path);
    }
    throw await toTransportError(res, `upload "${path}"`, opts);
  }

  private async resumeOffset(uploadUrl: string, path: string): Promise<number> {
    const res = await this.client.sendUnauthenticated(uploadUrl);
    if (!res.ok) {
      // An expired or lost session (404) or a server failure: the upload cannot be resumed.
      throw new SyncTransportError(
        res.status >= 500 ? 'NETWORK' : 'UNKNOWN',
        `OneDrive upload session for "${path}" could not be resumed (HTTP ${res.status}).`,
        res.status,
      );
    }
    const next = nextExpectedOffset(await res.json().catch(() => null));
    if (next === null) {
      throw new SyncTransportError(
        'UNKNOWN',
        `OneDrive upload session for "${path}" did not report where to resume.`,
      );
    }
    return next;
  }
}
