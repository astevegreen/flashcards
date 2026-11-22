import { compareCodeUnits, SyncTransportError } from '@flash/core';
import type { Auth, OneDriveBrowseItem, OneDriveFilePicker, PickedFile } from '@flash/platform';
import {
  codeForGraphStatus,
  GraphClient,
  readGraphError,
  type GraphChildrenPage,
  type GraphDriveItem,
} from '../sync/graph-client.ts';

/** File types the picker offers (same set as linked local folders, §3.2 / §15 Phase 12). */
export const ONEDRIVE_PICKABLE_EXTENSIONS = ['.csv', '.tsv', '.xlsx', '.flashpkg'] as const;
const MAX_PICK_BYTES = 50 * 1024 * 1024; // same cap as linked local-folder files
const PAGE_SIZE = 200;
/** Hard stop for very large folders: the browser shows the first N entries. */
const MAX_ITEMS_PER_FOLDER = 2000;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.flashpkg': 'application/zip',
};

/** The picker needs only these parts of the OneDrive `Auth` (web or native). */
export interface OneDrivePickerAuth extends Pick<Auth, 'getValidAccessToken' | 'isConfigured'> {
  hasScope(scope: string): Promise<boolean>;
  signIn: Auth['signIn'];
}

export interface GraphOneDriveFilePickerOptions {
  auth: OneDrivePickerAuth;
  fetchImpl?: typeof fetch;
  graphBaseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  maxBytes?: number;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

export function isPickableOneDriveFile(name: string): boolean {
  return (ONEDRIVE_PICKABLE_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

function toBrowseItem(item: GraphDriveItem): OneDriveBrowseItem | null {
  if (!item.id || !item.name) return null;
  if (item.folder) {
    return {
      id: item.id,
      name: item.name,
      kind: 'folder',
      size: 0,
      ...(item.folder.childCount === undefined ? {} : { childCount: item.folder.childCount }),
    };
  }
  if (!item.file || !isPickableOneDriveFile(item.name)) return null;
  const modified = item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : Number.NaN;
  return {
    id: item.id,
    name: item.name,
    kind: 'file',
    size: item.size ?? 0,
    ...(Number.isNaN(modified) ? {} : { lastModifiedAt: modified }),
  };
}

function compareBrowseItems(a: OneDriveBrowseItem, b: OneDriveBrowseItem): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return (
    compareCodeUnits(a.name.toLowerCase(), b.name.toLowerCase()) || compareCodeUnits(a.id, b.id)
  );
}

async function graphFailure(res: Response, action: string): Promise<SyncTransportError> {
  const { message } = await readGraphError(res);
  return new SyncTransportError(
    codeForGraphStatus(res.status),
    `OneDrive ${action} failed: ${message}`,
    res.status,
  );
}

/**
 * Optional OneDrive file picker (§15 Phase 12). Browses the user's drive through Graph with the
 * optional read-only `Files.Read` scope (incremental consent, requested only when the user opens
 * the picker) and downloads one `.csv` / `.tsv` / `.xlsx` / `.flashpkg` file. Runs entirely
 * in-app: no third-party picker iframe or script, so it needs no CSP `frame-src` / `script-src`.
 */
export class GraphOneDriveFilePicker implements OneDriveFilePicker {
  private readonly auth: OneDrivePickerAuth;
  private readonly client: GraphClient;
  private readonly maxBytes: number;

  constructor(options: GraphOneDriveFilePickerOptions) {
    this.auth = options.auth;
    this.client = new GraphClient({
      auth: options.auth,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.graphBaseUrl ? { graphBaseUrl: options.graphBaseUrl } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      maxAttempts: 3,
    });
    this.maxBytes = options.maxBytes ?? MAX_PICK_BYTES;
  }

  isConfigured(): boolean {
    return this.auth.isConfigured();
  }

  hasFileAccess(): Promise<boolean> {
    return this.auth.hasScope('Files.Read');
  }

  async requestFileAccess(): Promise<boolean> {
    // Web redirects away (resolves null); native sign-in resolves with a session.
    const session = await this.auth.signIn({ intent: 'sources' });
    return session !== null && (await this.hasFileAccess());
  }

  async listFolder(folderId?: string): Promise<OneDriveBrowseItem[]> {
    const path = folderId
      ? `/me/drive/items/${encodeURIComponent(folderId)}/children`
      : '/me/drive/root/children';
    const params = new URLSearchParams({
      $top: String(PAGE_SIZE),
      $select: 'id,name,size,lastModifiedDateTime,folder,file',
    });
    const out: OneDriveBrowseItem[] = [];
    let url: string | undefined = `${this.client.base}${path}?${params.toString()}`;
    while (url && out.length < MAX_ITEMS_PER_FOLDER) {
      const res = await this.client.send(url);
      if (!res.ok) throw await graphFailure(res, 'folder listing');
      const page = (await res.json()) as GraphChildrenPage;
      for (const raw of page.value ?? []) {
        const item = toBrowseItem(raw);
        if (item) out.push(item);
      }
      url = page['@odata.nextLink'];
    }
    return out.sort(compareBrowseItems);
  }

  async downloadFile(item: OneDriveBrowseItem): Promise<PickedFile> {
    if (item.kind !== 'file' || !isPickableOneDriveFile(item.name)) {
      throw new SyncTransportError(
        'UNKNOWN',
        `"${item.name}" is not a .csv, .tsv, .xlsx or .flashpkg file.`,
      );
    }
    if (item.size > this.maxBytes) {
      throw new SyncTransportError(
        'UNKNOWN',
        `"${item.name}" is larger than the 50 MB import limit.`,
      );
    }
    const metaRes = await this.client.send(
      `${this.client.base}/me/drive/items/${encodeURIComponent(item.id)}`,
    );
    if (!metaRes.ok) throw await graphFailure(metaRes, `download of "${item.name}"`);
    const meta = (await metaRes.json()) as GraphDriveItem;
    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      throw new SyncTransportError(
        'UNKNOWN',
        `OneDrive returned no download link for "${item.name}".`,
      );
    }
    const res = await this.client.sendUnauthenticated(downloadUrl);
    if (!res.ok) throw await graphFailure(res, `download of "${item.name}"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > this.maxBytes) {
      throw new SyncTransportError(
        'UNKNOWN',
        `"${item.name}" is larger than the 50 MB import limit.`,
      );
    }
    const mime = MIME_BY_EXTENSION[extensionOf(item.name)];
    return { name: item.name, bytes, ...(mime ? { mime } : {}) };
  }
}
