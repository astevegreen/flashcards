import type { SyncFileInfo, SyncTransport } from '@flash/platform';

const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT_BASE = 'https://content.dropboxapi.com/2';

export interface DropboxTransportOptions {
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** App-folder root subfolder prefix inside Dropbox App Folder (default empty = root). */
  rootPrefix?: string;
}

export class DropboxTransportError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DropboxTransportError';
    if (status !== undefined) this.status = status;
  }
}

function normalizeSyncPath(path: string, rootPrefix = ''): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..') || clean.includes('\0')) {
    throw new DropboxTransportError(`Unsafe Dropbox sync path "${path}".`);
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
 */
export class DropboxAppFolderTransport implements SyncTransport {
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly rootPrefix: string;

  constructor(options: DropboxTransportOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.rootPrefix = options.rootPrefix ?? '';
  }

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const token = await this.getAccessToken();
    const folderPath = normalizeSyncPath(prefix, this.rootPrefix).replace(/\/+$/, '');
    const results: SyncFileInfo[] = [];

    const res = await this.fetchImpl(`${DROPBOX_API_BASE}/files/list_folder`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: folderPath === '/' ? '' : folderPath,
        recursive: true,
        include_deleted: false,
      }),
    });

    if (res.status === 409) {
      // Folder does not exist yet in empty App Folder
      return [];
    }
    if (!res.ok) {
      throw new DropboxTransportError(`Dropbox list_folder failed (${res.status})`, res.status);
    }

    let page = (await res.json()) as DropboxListResponse;
    const collect = (entries: DropboxListEntry[]) => {
      for (const entry of entries) {
        if (entry['.tag'] !== 'file') continue;
        const rawPath = entry.path_display ?? entry.path_lower;
        if (!rawPath) continue;
        const rel = stripRootPrefix(rawPath, this.rootPrefix);
        results.push({
          path: rel,
          size: entry.size ?? 0,
          ...(entry.server_modified ? { updatedAt: Date.parse(entry.server_modified) } : {}),
        });
      }
    };
    collect(page.entries);

    while (page.has_more) {
      const contRes = await this.fetchImpl(`${DROPBOX_API_BASE}/files/list_folder/continue`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cursor: page.cursor }),
      });
      if (!contRes.ok) {
        throw new DropboxTransportError(
          `Dropbox list_folder/continue failed (${contRes.status})`,
          contRes.status,
        );
      }
      page = (await contRes.json()) as DropboxListResponse;
      collect(page.entries);
    }

    return results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async read(path: string): Promise<Uint8Array> {
    const token = await this.getAccessToken();
    const dropboxPath = normalizeSyncPath(path, this.rootPrefix);
    const res = await this.fetchImpl(`${DROPBOX_CONTENT_BASE}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }),
      },
    });
    if (!res.ok) {
      throw new DropboxTransportError(
        `Dropbox download "${path}" failed (${res.status})`,
        res.status,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    const token = await this.getAccessToken();
    const dropboxPath = normalizeSyncPath(path, this.rootPrefix);
    const bodyCopy = new Uint8Array(data);
    const res = await this.fetchImpl(`${DROPBOX_CONTENT_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
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
    if (!res.ok) {
      // Ignore write-once conflict (`path/conflict/file`) when ifAbsent is true
      if (opts?.ifAbsent && res.status === 409) {
        return;
      }
      throw new DropboxTransportError(
        `Dropbox upload "${path}" failed (${res.status})`,
        res.status,
      );
    }
  }
}

/** Builds a Dropbox PKCE authorization URL (`token_access_type=offline`, §4.3). */
export function buildDropboxPkceAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  return url.toString();
}
