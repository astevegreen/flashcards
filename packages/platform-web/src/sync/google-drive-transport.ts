import { compareCodeUnits, SyncTransportError } from '@flash/core';
import type { Auth, SyncFileInfo, SyncTransport } from '@flash/platform';
import { isGoogleRateLimited } from './google-errors.ts';

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 250;

interface DriveFileRecord {
  id: string;
  name: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  appProperties?: Record<string, string>;
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

/** `appProperties` mark on files created with `ifAbsent` (write-once), see {@link pickDriveCopy}. */
const WRITE_ONCE_PROPERTY = 'flashWriteOnce';
const FILE_FIELDS = 'id,name,size,createdTime,modifiedTime,appProperties';

function driveTime(value: string | undefined): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The copy every device uses when Drive holds several files with one name (C23). Drive has no
 * create-if-absent, so two devices can both create a write-once file; those copies carry
 * {@link WRITE_ONCE_PROPERTY} and the first created wins, the same rule `write` uses to decide
 * which racer keeps its file. Files without the mark (mutable `head.json`, or from older builds)
 * keep the newest-modified rule. Ties go to the smaller id, so the pick never depends on the
 * order Drive lists them in.
 */
function pickDriveCopy(files: readonly DriveFileRecord[]): DriveFileRecord | undefined {
  const writeOnce = files.every((f) => f.appProperties?.[WRITE_ONCE_PROPERTY] === '1');
  let best: DriveFileRecord | undefined;
  for (const f of files) {
    if (!best) {
      best = f;
      continue;
    }
    const byTime = writeOnce
      ? driveTime(f.createdTime) - driveTime(best.createdTime)
      : driveTime(best.modifiedTime) - driveTime(f.modifiedTime);
    if (byTime < 0 || (byTime === 0 && f.id < best.id)) best = f;
  }
  return best;
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

      const rateLimited = await isGoogleRateLimited(res);
      if (
        (rateLimited || (res.status >= 500 && res.status <= 504)) &&
        transientAttempts + 1 < MAX_RETRY_ATTEMPTS
      ) {
        const delayMs = BASE_RETRY_DELAY_MS * Math.pow(3, transientAttempts);
        transientAttempts += 1;
        await this.sleep(delayMs);
        continue;
      }

      if (rateLimited) {
        throw new SyncTransportError(
          'RATE_LIMITED',
          'Google Drive rate limit exceeded.',
          res.status,
        );
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

    const best = pickDriveCopy(await this.lookupByName(path));
    if (!best) {
      this.pathToId.delete(path);
      return null;
    }
    this.pathToId.set(path, best.id);
    return best.id;
  }

  /** Every non-trashed file named `path` (Drive allows several). */
  private async lookupByName(path: string): Promise<DriveFileRecord[]> {
    const q = `name = '${escapeDriveQuery(path)}' and trashed = false`;
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      pageSize: '100',
      q,
      fields: `files(${FILE_FIELDS})`,
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
    return (data.files ?? []).filter((f) => f.name === path);
  }

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const byPath = new Map<string, DriveFileRecord[]>();
    let pageToken: string | undefined;

    do {
      // Query all non-trashed files in private appDataFolder and apply exact prefix matching
      // client-side so Google Drive's word-tokenized `name contains` never misses slash paths.
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        pageSize: '1000',
        q: 'trashed = false',
        fields: `nextPageToken,files(${FILE_FIELDS})`,
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
        if (!file.name.startsWith(prefix)) continue;
        const copies = byPath.get(file.name);
        if (copies) copies.push(file);
        else byPath.set(file.name, [file]);
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    const out: SyncFileInfo[] = [];
    for (const [path, copies] of byPath) {
      const file = pickDriveCopy(copies);
      if (!file) continue;
      this.pathToId.set(path, file.id);
      const updatedAt = file.modifiedTime ? Date.parse(file.modifiedTime) : Number.NaN;
      out.push({
        path,
        size: file.size ? Number.parseInt(file.size, 10) || 0 : 0,
        ...(Number.isNaN(updatedAt) ? {} : { updatedAt }),
      });
    }
    return out.sort((a, b) => compareCodeUnits(a.path, b.path));
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
      {
        name: path,
        parents: ['appDataFolder'],
        ...(opts?.ifAbsent ? { appProperties: { [WRITE_ONCE_PROPERTY]: '1' } } : {}),
      },
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
      if (opts?.ifAbsent) await this.keepFirstCopy(path, created.id);
    }
  }

  /**
   * Drive's create cannot fail on an existing name, so a write-once create is checked after the
   * fact (C23): when another device created the same file first, this device removes its own copy
   * and reports `ALREADY_EXISTS`, as the contract asks, and reads then go to the first copy. A
   * copy the lookup does not show yet counts as kept.
   */
  private async keepFirstCopy(path: string, createdId: string): Promise<void> {
    const copies = await this.lookupByName(path);
    const first = pickDriveCopy(copies);
    if (!first || first.id === createdId || !copies.some((f) => f.id === createdId)) return;
    this.pathToId.set(path, first.id);
    // A failed delete throws and the sync retries; the copy it leaves is harmless, since every
    // device reads the first one.
    const res = await this.authorizedFetch(`${DRIVE_FILES_API}/${encodeURIComponent(createdId)}`, {
      method: 'DELETE',
    });
    await res.body?.cancel();
    throw new SyncTransportError(
      'ALREADY_EXISTS',
      `Google Drive write-once file was created first by another device: "${path}"`,
    );
  }
}
