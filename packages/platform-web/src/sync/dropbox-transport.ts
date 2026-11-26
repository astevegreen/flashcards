import { SyncTransportError } from '@flash/core';
import { isUnsafeCloudPath } from './cloud-path.ts';
import type { SyncFileInfo, SyncTransport } from '@flash/platform';
import { AuthorizedHttpClient } from './authorized-http.ts';
import { dropboxFailure } from './dropbox-errors.ts';

const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT_BASE = 'https://content.dropboxapi.com/2';

export interface DropboxTransportOptions {
  /** Returns a valid access token; `forceRefresh` is passed once after a 401. */
  getAccessToken: (opts?: { forceRefresh?: boolean }) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** App-folder root subfolder prefix inside Dropbox App Folder (default empty = root). */
  rootPrefix?: string;
  /** Backoff hooks (injectable for deterministic tests). */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
}

function normalizeSyncPath(path: string, rootPrefix = ''): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || isUnsafeCloudPath(clean)) {
    throw new SyncTransportError('UNKNOWN', `Unsafe Dropbox sync path "${path}".`);
  }
  const base = rootPrefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return base ? `/${base}/${clean}` : `/${clean}`;
}

function stripRootPrefix(dropboxPathLower: string, rootPrefix = ''): string {
  const base = rootPrefix
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
  const clean = dropboxPathLower.replace(/^\/+/, '');
  if (base && clean.toLowerCase().startsWith(`${base}/`)) {
    return clean.slice(base.length + 1);
  }
  return clean;
}

interface DropboxListEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  path_display?: string;
  path_lower?: string;
  size?: number;
  server_modified?: string;
}

interface DropboxListResponse {
  entries: DropboxListEntry[];
  cursor: string;
  has_more: boolean;
}

/**
 * Pluggable Dropbox App Folder `SyncTransport` (§4.3, §15 Phase 8).
 * Operates inside the app's scoped Dropbox App Folder using OAuth PKCE tokens.
 *
 * Errors follow the `SyncTransport` contract the sync engine relies on: a missing file is
 * `SyncTransportError('NOT_FOUND')` (Dropbox sends 409 `path/not_found`), and a write-once
 * conflict is `ALREADY_EXISTS`. A 401 refreshes the token once; 429 / 5xx retry with backoff.
 */

/** Strips leading (and, for `both`, trailing) slashes without a backtracking regex. */
function trimSlashes(path: string, ends: 'start' | 'both'): string {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === '/') start += 1;
  if (ends === 'both') while (end > start && path[end - 1] === '/') end -= 1;
  return path.slice(start, end);
}
export class DropboxAppFolderTransport implements SyncTransport {
  private readonly client: AuthorizedHttpClient;
  private readonly rootPrefix: string;

  constructor(options: DropboxTransportOptions) {
    this.client = new AuthorizedHttpClient(
      {
        auth: { getValidAccessToken: (opts) => options.getAccessToken(opts) },
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.random ? { random: options.random } : {}),
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      },
      'Dropbox',
    );
    this.rootPrefix = options.rootPrefix ?? '';
  }

  private postJson(url: string, body: unknown): Promise<Response> {
    return this.client.send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async list(prefix: string): Promise<SyncFileInfo[]> {
    // `list_folder` takes a folder, so list the prefix's parent folder recursively and keep the
    // paths that start with the full prefix (`sync/v1/devices/` and `…/seg-` both work).
    const cleanPrefix = trimSlashes(prefix.replaceAll('\\', '/'), 'start');
    const slash = cleanPrefix.lastIndexOf('/');
    const folder = slash === -1 ? '' : cleanPrefix.slice(0, slash);
    const base = trimSlashes(this.rootPrefix.replaceAll('\\', '/'), 'both');
    let folderPath = '';
    if (folder) folderPath = normalizeSyncPath(folder, this.rootPrefix);
    else if (base) folderPath = `/${base}`;
    const results: SyncFileInfo[] = [];

    const res = await this.postJson(`${DROPBOX_API_BASE}/files/list_folder`, {
      path: folderPath,
      recursive: true,
      include_deleted: false,
    });
    if (!res.ok) {
      const failure = await dropboxFailure(res, `listing of "${prefix}"`);
      // The folder does not exist yet in an empty App Folder.
      if (failure.code === 'NOT_FOUND') return [];
      throw failure;
    }

    let page = (await res.json()) as DropboxListResponse;
    const collect = (entries: DropboxListEntry[]) => {
      for (const entry of entries) {
        if (entry['.tag'] !== 'file') continue;
        const rawPath = entry.path_display ?? entry.path_lower;
        if (!rawPath) continue;
        const rel = stripRootPrefix(rawPath, this.rootPrefix);
        if (!rel.startsWith(cleanPrefix)) continue;
        results.push({
          path: rel,
          size: entry.size ?? 0,
          ...(entry.server_modified ? { updatedAt: Date.parse(entry.server_modified) } : {}),
        });
      }
    };
    collect(page.entries);

    while (page.has_more) {
      const contRes = await this.postJson(`${DROPBOX_API_BASE}/files/list_folder/continue`, {
        cursor: page.cursor,
      });
      if (!contRes.ok) throw await dropboxFailure(contRes, `listing of "${prefix}"`);
      page = (await contRes.json()) as DropboxListResponse;
      collect(page.entries);
    }

    return results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async read(path: string): Promise<Uint8Array> {
    const dropboxPath = normalizeSyncPath(path, this.rootPrefix);
    const res = await this.client.send(`${DROPBOX_CONTENT_BASE}/files/download`, {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }) },
    });
    if (!res.ok) throw await dropboxFailure(res, `download of "${path}"`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    const dropboxPath = normalizeSyncPath(path, this.rootPrefix);
    const bodyCopy = new Uint8Array(data);
    const res = await this.client.send(`${DROPBOX_CONTENT_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: dropboxPath,
          mode: opts?.ifAbsent ? 'add' : 'overwrite',
          autorename: false,
          mute: true,
        }),
      },
      body: bodyCopy.buffer,
    });
    // A write-once conflict (`path/conflict/file`) surfaces as ALREADY_EXISTS, which the sync
    // engine handles (adopting a raced manifest, crash-recovering a segment). Any other failure,
    // such as `path/insufficient_space`, is thrown so a missing file never passes as written.
    if (!res.ok) throw await dropboxFailure(res, `upload of "${path}"`);
  }
}

/**
 * Granular scopes for the Dropbox App Folder connector: used by both Sync and Linked Sources
 * so one Dropbox sign-in powers both (§4.3).
 */
export const DROPBOX_APP_FOLDER_SCOPES =
  'files.metadata.read files.content.read files.content.write';

/** Builds a Dropbox PKCE authorization URL (`token_access_type=offline`, §4.3). */
export function buildDropboxPkceAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('scope', params.scope ?? DROPBOX_APP_FOLDER_SCOPES);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  return url.toString();
}
