import { SyncTransportError } from '@flash/core';
import type { Auth, SyncFileInfo, SyncTransport } from '@flash/platform';

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 250;

interface DriveFileRecord {
  id: string;
  name: string;
  size?: string;
  modifiedTime?: string;
}

interface DriveListResponse {
  files?: DriveFileRecord[];
  nextPageToken?: string;
}

export interface GoogleDriveTransportOptions {
  auth: Auth;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildMultipartRelatedBody(
  metadata: Record<string, unknown>,
  binaryPayload: Uint8Array,
  boundary: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const part1 = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
  );
  const part2Header = encoder.encode(
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const closing = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(
    part1.byteLength + part2Header.byteLength + binaryPayload.byteLength + closing.byteLength,
  );
  let offset = 0;
  body.set(part1, offset);
  offset += part1.byteLength;
  body.set(part2Header, offset);
  offset += part2Header.byteLength;
  body.set(binaryPayload, offset);
  offset += binaryPayload.byteLength;
  body.set(closing, offset);
  return body;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Google Drive `drive.appdata` SyncTransport (§4.3).
 * Stores every `sync/v1/...` object directly inside `parents: ['appDataFolder']`
 * using its exact logical path as Drive `name`, eliminating nested-folder races.
 */
export class GoogleDriveAppDataTransport implements SyncTransport {
  private readonly auth: Auth;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pathToId = new Map<string, string>();

  constructor(options: GoogleDriveTransportOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? defaultSleep;
  }

  private async authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    let token = await this.auth.getValidAccessToken();
    let refreshedOnce = false;
    let transientAttempts = 0;

    while (transientAttempts < MAX_RETRY_ATTEMPTS) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);

      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, headers });
      } catch (err) {
        throw new SyncTransportError(
          'NETWORK',
          `Google Drive network error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (res.status === 401) {
        if (!refreshedOnce) {
          refreshedOnce = true;
          token = await this.auth.getValidAccessToken({ forceRefresh: true });
          continue;
        }
        throw new SyncTransportError(
          'AUTH_REQUIRED',
          'Google Drive rejected credentials after refresh. Please reconnect.',
          401,
        );
      }

      if (
        (res.status === 429 || (res.status >= 500 && res.status <= 504)) &&
        transientAttempts + 1 < MAX_RETRY_ATTEMPTS
      ) {
        const delayMs = BASE_RETRY_DELAY_MS * Math.pow(3, transientAttempts);
        transientAttempts += 1;
        await this.sleep(delayMs);
        continue;
      }

      if (res.status === 429) {
        throw new SyncTransportError('RATE_LIMITED', 'Google Drive rate limit exceeded.', 429);
      }
      if (res.status === 403) {
        throw new SyncTransportError(
          'PERMISSION_DENIED',
          'Google Drive permission denied for appDataFolder.',
          403,
        );
      }
      if (res.status >= 500) {
        throw new SyncTransportError(
          'NETWORK',
          `Google Drive server error (HTTP ${res.status}).`,
          res.status,
        );
      }

      return res;
    }

    throw new SyncTransportError('NETWORK', 'Google Drive request failed after retries.');
  }

  private async findFileId(path: string, bypassCache = false): Promise<string | null> {
    if (!bypassCache) {
      const cached = this.pathToId.get(path);
      if (cached) return cached;
    }

    const q = `name = '${escapeDriveQuery(path)}' and trashed = false`;
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      pageSize: '10',
      q,
      fields: 'files(id,name,modifiedTime)',
    });
    const res = await this.authorizedFetch(`${DRIVE_FILES_API}?${params.toString()}`);
    if (!res.ok) {
      throw new SyncTransportError(
        'UNKNOWN',
        `Google Drive lookup failed for "${path}" (HTTP ${res.status}).`,
        res.status,
      );
    }

    const data = (await res.json()) as DriveListResponse;
    const matches = (data.files ?? []).filter((f) => f.name === path);
    if (matches.length === 0) {
      this.pathToId.delete(path);
      return null;
    }

    matches.sort((a, b) => {
      const ta = a.modifiedTime ? Date.parse(a.modifiedTime) : 0;
      const tb = b.modifiedTime ? Date.parse(b.modifiedTime) : 0;
      return tb - ta;
    });
    const best = matches[0];
    if (!best) return null;
    this.pathToId.set(path, best.id);
    return best.id;
  }

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const byPath = new Map<string, SyncFileInfo>();
    let pageToken: string | undefined;

    do {
      // Query all non-trashed files in private appDataFolder and apply exact prefix matching
      // client-side so Google Drive's word-tokenized `name contains` never misses slash paths.
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        pageSize: '1000',
        q: 'trashed = false',
        fields: 'nextPageToken,files(id,name,size,modifiedTime)',
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      const res = await this.authorizedFetch(`${DRIVE_FILES_API}?${params.toString()}`);
      if (!res.ok) {
        throw new SyncTransportError(
          'UNKNOWN',
          `Google Drive list failed (HTTP ${res.status}).`,
          res.status,
        );
      }

      const data = (await res.json()) as DriveListResponse;
      for (const file of data.files ?? []) {
        const updatedAt = file.modifiedTime ? Date.parse(file.modifiedTime) : undefined;
        if (!file.name.startsWith(prefix)) continue;
        const size = file.size ? Number.parseInt(file.size, 10) || 0 : 0;
        const existing = byPath.get(file.name);
        if (!existing || (updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
          byPath.set(file.name, {
            path: file.name,
            size,
            ...(updatedAt !== undefined && !Number.isNaN(updatedAt) ? { updatedAt } : {}),
          });
          this.pathToId.set(file.name, file.id);
        }
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async read(path: string): Promise<Uint8Array> {
    const cachedId = this.pathToId.get(path);
    let fileId = cachedId ?? (await this.findFileId(path, true));
    if (!fileId) {
      throw new SyncTransportError('NOT_FOUND', `Google Drive file not found: "${path}"`, 404);
    }

    let res = await this.authorizedFetch(
      `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?alt=media`,
    );
    if (res.status === 404 && cachedId) {
      // Cached fileId went stale; re-resolve from Drive once before giving up.
      this.pathToId.delete(path);
      fileId = await this.findFileId(path, true);
      if (!fileId) {
        throw new SyncTransportError('NOT_FOUND', `Google Drive file not found: "${path}"`, 404);
      }
      res = await this.authorizedFetch(
        `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?alt=media`,
      );
    }
    if (res.status === 404) {
      this.pathToId.delete(path);
      throw new SyncTransportError('NOT_FOUND', `Google Drive file not found: "${path}"`, 404);
    }
    if (!res.ok) {
      throw new SyncTransportError(
        'UNKNOWN',
        `Google Drive read failed for "${path}" (HTTP ${res.status}).`,
        res.status,
      );
    }

    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    const existingId = await this.findFileId(path, Boolean(opts?.ifAbsent));

    if (existingId && opts?.ifAbsent) {
      throw new SyncTransportError(
        'ALREADY_EXISTS',
        `Google Drive write-once file already exists: "${path}"`,
      );
    }

    if (existingId) {
      const patchRes = await this.authorizedFetch(
        `${DRIVE_UPLOAD_API}/${encodeURIComponent(existingId)}?uploadType=media`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: toArrayBuffer(data),
        },
      );
      if (patchRes.status === 404) {
        // Stale cached fileId; fall through to create
        this.pathToId.delete(path);
      } else if (!patchRes.ok) {
        throw new SyncTransportError(
          'UNKNOWN',
          `Google Drive update failed for "${path}" (HTTP ${patchRes.status}).`,
          patchRes.status,
        );
      } else {
        return;
      }
    }

    const rand =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '')
        : `${Date.now().toString(16)}_${Math.random().toString(36).slice(2, 12)}`;
    const boundary = `flash_sync_${rand}`;
    const multipartBody = buildMultipartRelatedBody(
      { name: path, parents: ['appDataFolder'] },
      data,
      boundary,
    );

    const createRes = await this.authorizedFetch(
      `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,name`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: toArrayBuffer(multipartBody),
      },
    );

    if (!createRes.ok) {
      throw new SyncTransportError(
        'UNKNOWN',
        `Google Drive upload failed for "${path}" (HTTP ${createRes.status}).`,
        createRes.status,
      );
    }

    const created = (await createRes.json().catch(() => null)) as { id?: string } | null;
    if (created?.id) {
      this.pathToId.set(path, created.id);
    }
  }
}
