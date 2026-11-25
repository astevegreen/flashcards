import { compareCodeUnits, SyncTransportError } from '@flash/core';
import type {
  Auth,
  DropboxBrowseItem,
  DropboxFileInfo,
  DropboxFilePicker,
  PickedFile,
} from '@flash/platform';
import { dropboxFailure } from '../sync/dropbox-errors.ts';

const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT_BASE = 'https://content.dropboxapi.com/2';

/** File types the Dropbox App Folder picker offers (same set as OneDrive / local folders). */
export const DROPBOX_PICKABLE_EXTENSIONS = ['.csv', '.tsv', '.xlsx', '.flashpkg'] as const;
const MAX_PICK_BYTES = 50 * 1024 * 1024; // 50 MiB cap (§13)
const MAX_ITEMS_PER_FOLDER = 2000;

/**
 * Top-level folders inside the Dropbox App Folder owned by the sync engine (`sync/v1/...`,
 * `media/<aa>/<hash>.<ext>`). Hidden from the user's file browser at App Folder root so sync
 * data is never confused with user spreadsheets.
 */
export const DROPBOX_SYNC_ROOT_FOLDERS = new Set(['sync', 'media']);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.flashpkg': 'application/zip',
};

export type DropboxPickerAuth = Pick<
  Auth,
  'isConfigured' | 'isConnected' | 'signIn' | 'getValidAccessToken'
>;

export interface DropboxAppFolderFilePickerOptions {
  auth: DropboxPickerAuth;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  contentBaseUrl?: string;
  maxBytes?: number;
}

interface DropboxRawEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  name?: string;
  path_display?: string;
  path_lower?: string;
  size?: number;
  rev?: string;
  content_hash?: string;
  server_modified?: string;
}

interface DropboxListFolderResponse {
  entries: DropboxRawEntry[];
  cursor: string;
  has_more: boolean;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

export function isPickableDropboxFile(name: string): boolean {
  return (DROPBOX_PICKABLE_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/**
 * Encodes a JSON object for the `Dropbox-API-Arg` HTTP header: Dropbox requires non-ASCII
 * characters in HTTP headers to be `\uXXXX`-escaped.
 */
export function encodeDropboxApiArg(arg: unknown): string {
  return JSON.stringify(arg).replace(/[\u007f-\uffff]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

function normalizeFolderPath(folderPath?: string): string {
  if (!folderPath) return '';
  const trimmed = folderPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  if (trimmed.includes('..') || trimmed.includes('\0')) {
    throw new SyncTransportError('UNKNOWN', `Unsafe Dropbox folder path "${folderPath}".`);
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeFileSelector(fileIdOrPath: string): string {
  const trimmed = fileIdOrPath.trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw new SyncTransportError('UNKNOWN', `Invalid Dropbox file identifier "${fileIdOrPath}".`);
  }
  if (trimmed.startsWith('id:')) return trimmed;
  const clean = trimmed.replace(/\\/g, '/');
  if (clean.includes('..')) {
    throw new SyncTransportError('UNKNOWN', `Unsafe Dropbox file path "${fileIdOrPath}".`);
  }
  return clean.startsWith('/') ? clean : `/${clean}`;
}

function compareBrowseItems(a: DropboxBrowseItem, b: DropboxBrowseItem): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return (
    compareCodeUnits(a.name.toLowerCase(), b.name.toLowerCase()) || compareCodeUnits(a.id, b.id)
  );
}

function toBrowseItem(entry: DropboxRawEntry, isRoot: boolean): DropboxBrowseItem | null {
  if (entry['.tag'] === 'deleted') return null;
  const name = entry.name?.trim();
  const pathDisplay = entry.path_display ?? entry.path_lower;
  const pathLower = entry.path_lower ?? pathDisplay?.toLowerCase();
  if (!name || !pathDisplay || !pathLower) return null;
  const id = entry.id ?? pathLower;

  if (entry['.tag'] === 'folder') {
    if (isRoot && DROPBOX_SYNC_ROOT_FOLDERS.has(name.toLowerCase())) {
      return null;
    }
    return {
      id,
      name,
      pathDisplay,
      pathLower,
      kind: 'folder',
      size: 0,
    };
  }

  if (entry['.tag'] !== 'file' || !isPickableDropboxFile(name)) return null;
  const modified = entry.server_modified ? Date.parse(entry.server_modified) : Number.NaN;
  return {
    id,
    name,
    pathDisplay,
    pathLower,
    kind: 'file',
    size: entry.size ?? 0,
    ...(Number.isNaN(modified) ? {} : { lastModifiedAt: modified }),
  };
}

/**
 * Dropbox App Folder file picker.
 * Browses `Dropbox/Apps/<app name>/` using the same PKCE App Folder OAuth sign-in as Dropbox Sync,
 * hiding the internal `sync/` and `media/` folders at the root.
 */
export class DropboxAppFolderFilePicker implements DropboxFilePicker {
  private readonly auth: DropboxPickerAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly contentBase: string;
  private readonly maxBytes: number;

  constructor(options: DropboxAppFolderFilePickerOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.apiBase = (options.apiBaseUrl ?? DROPBOX_API_BASE).replace(/\/+$/, '');
    this.contentBase = (options.contentBaseUrl ?? DROPBOX_CONTENT_BASE).replace(/\/+$/, '');
    this.maxBytes = options.maxBytes ?? MAX_PICK_BYTES;
  }

  isConfigured(): boolean {
    return this.auth.isConfigured();
  }

  isConnected(): Promise<boolean> {
    return this.auth.isConnected();
  }

  async connect(): Promise<boolean> {
    // Web redirects away (resolves null); native sign-in resolves with a session.
    const session = await this.auth.signIn({ intent: 'sources' });
    return session !== null && (await this.auth.isConnected());
  }

  private async authedFetch(
    url: string,
    buildInit: (token: string) => RequestInit,
  ): Promise<Response> {
    let token = await this.auth.getValidAccessToken();
    let res: Response;
    try {
      res = await this.fetchImpl(url, buildInit(token));
    } catch (err) {
      throw new SyncTransportError(
        'NETWORK',
        `Dropbox request failed (offline or unreachable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 401) {
      token = await this.auth.getValidAccessToken({ forceRefresh: true });
      try {
        res = await this.fetchImpl(url, buildInit(token));
      } catch (err) {
        throw new SyncTransportError(
          'NETWORK',
          `Dropbox request failed (offline or unreachable): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return res;
  }

  async listFolder(folderPath?: string): Promise<DropboxBrowseItem[]> {
    const normalized = normalizeFolderPath(folderPath);
    const isRoot = normalized === '';
    const res = await this.authedFetch(`${this.apiBase}/files/list_folder`, (token) => ({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: normalized,
        recursive: false,
        include_deleted: false,
      }),
    }));

    if (res.status === 409 && isRoot) {
      // Empty / freshly created App Folder
      return [];
    }
    if (!res.ok) throw await dropboxFailure(res, 'folder listing');

    const out: DropboxBrowseItem[] = [];
    const collect = (entries: readonly DropboxRawEntry[]) => {
      for (const entry of entries) {
        if (out.length >= MAX_ITEMS_PER_FOLDER) break;
        const item = toBrowseItem(entry, isRoot);
        if (item) out.push(item);
      }
    };

    let page = (await res.json()) as DropboxListFolderResponse;
    collect(page.entries ?? []);

    while (page.has_more && out.length < MAX_ITEMS_PER_FOLDER) {
      const contRes = await this.authedFetch(
        `${this.apiBase}/files/list_folder/continue`,
        (token) => ({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cursor: page.cursor }),
        }),
      );
      if (!contRes.ok) throw await dropboxFailure(contRes, 'folder listing');
      page = (await contRes.json()) as DropboxListFolderResponse;
      collect(page.entries ?? []);
    }

    return out.sort(compareBrowseItems);
  }

  async getFileInfo(fileIdOrPath: string): Promise<DropboxFileInfo> {
    const selector = normalizeFileSelector(fileIdOrPath);
    const res = await this.authedFetch(`${this.apiBase}/files/get_metadata`, (token) => ({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: selector }),
    }));
    if (!res.ok) throw await dropboxFailure(res, 'file lookup');
    const raw = (await res.json()) as DropboxRawEntry;
    if (raw['.tag'] !== 'file') {
      throw new SyncTransportError('UNKNOWN', `Dropbox entry "${fileIdOrPath}" is not a file.`);
    }
    const name = raw.name ?? selector;
    const pathDisplay = raw.path_display ?? raw.path_lower ?? name;
    const modified = raw.server_modified ? Date.parse(raw.server_modified) : Number.NaN;
    const contentTag = raw.content_hash || raw.rev;
    return {
      id: raw.id ?? selector,
      name,
      pathDisplay,
      size: raw.size ?? 0,
      ...(raw.rev ? { rev: raw.rev } : {}),
      ...(raw.content_hash ? { contentHash: raw.content_hash } : {}),
      ...(contentTag ? { contentTag } : {}),
      ...(Number.isNaN(modified) ? {} : { lastModifiedAt: modified }),
    };
  }

  async downloadFile(item: DropboxBrowseItem): Promise<PickedFile> {
    if (item.kind !== 'file' || !isPickableDropboxFile(item.name)) {
      throw new SyncTransportError(
        'UNKNOWN',
        `"${item.name}" is not a .csv, .tsv, .xlsx or .flashpkg file.`,
      );
    }
    return this.downloadById(item.id || item.pathLower, item.size);
  }

  async downloadById(fileIdOrPath: string, knownSize?: number): Promise<PickedFile> {
    if (knownSize !== undefined && knownSize > this.maxBytes) {
      throw new SyncTransportError('UNKNOWN', 'This file is larger than the 50 MB import limit.');
    }
    const info = await this.getFileInfo(fileIdOrPath);
    if (!isPickableDropboxFile(info.name)) {
      throw new SyncTransportError(
        'UNKNOWN',
        `"${info.name}" is not a .csv, .tsv, .xlsx or .flashpkg file.`,
      );
    }
    if (info.size > this.maxBytes) {
      throw new SyncTransportError(
        'UNKNOWN',
        `"${info.name}" is larger than the 50 MB import limit.`,
      );
    }

    const selector = normalizeFileSelector(info.id || fileIdOrPath);
    const res = await this.authedFetch(`${this.contentBase}/files/download`, (token) => ({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': encodeDropboxApiArg({ path: selector }),
      },
    }));
    if (!res.ok) throw await dropboxFailure(res, `download of "${info.name}"`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > this.maxBytes) {
      throw new SyncTransportError(
        'UNKNOWN',
        `"${info.name}" is larger than the 50 MB import limit.`,
      );
    }
    const mime = MIME_BY_EXTENSION[extensionOf(info.name)];
    return {
      name: info.name,
      bytes,
      size: bytes.byteLength,
      ...(mime ? { mime } : {}),
    };
  }
}
