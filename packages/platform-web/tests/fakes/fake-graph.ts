/**
 * In-process fake of the Microsoft Graph endpoints the OneDrive transport and picker use
 * (§15 Phase 12). Framework-agnostic and dependency-free so Vitest (via `fakeGraph.fetch`) and
 * Playwright (via `page.route` -> `fakeGraph.handle`) share one implementation. No real network.
 *
 * Implemented:
 * - App folder (`/me/drive/special/approot`): children listing (paged), item metadata with a
 *   pre-authenticated `@microsoft.graph.downloadUrl`, simple `PUT …:/content` (≤ 4 MB) honoring
 *   `@microsoft.graph.conflictBehavior`, and `createUploadSession` + fragment PUTs that enforce
 *   `Content-Range` and 320 KiB multiples.
 * - User drive for the picker: `/me/drive/root/children`, `/me/drive/items/{id}/children`,
 *   `/me/drive/items/{id}` (download URL).
 * - Bearer-token checks (401 for unknown tokens), and fault injection for 429 / 503 / 401.
 */

// Relative path: the Playwright e2e imports this fake too, outside the workspace resolver.
import { compareCodeUnits } from '../../../core/src/study/queue.ts';

export const FAKE_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
export const FAKE_DOWNLOAD_ORIGIN = 'https://fake-onedrive-download.test';
export const FAKE_UPLOAD_ORIGIN = 'https://fake-onedrive-upload.test';
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
const FRAGMENT_UNIT = 320 * 1024;

export interface FakeRequest {
  method: string;
  url: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body?: Uint8Array | undefined;
}

export interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface FakeFault {
  /** Matches `"<METHOD> <pathname>"`, e.g. `PUT /v1.0/me/drive/special/approot:/a.json:/content`. */
  match: (req: FakeRequest) => boolean;
  status: number;
  headers?: Record<string, string>;
  /** How many matching requests fail (default 1). */
  times?: number;
  /** Process the request normally, then still answer with the fault (a lost response). */
  applyThenFail?: boolean;
}

interface StoredFile {
  id: string;
  bytes: Uint8Array;
  modifiedAt: number;
}

interface UploadSession {
  path: string;
  conflictBehavior: string;
  total: number | null;
  received: Uint8Array[];
  receivedBytes: number;
}

/** A tree of files keyed by `/`-joined path; folders are implied by file paths. */
class FakeTree {
  readonly files = new Map<string, StoredFile>();
  private nextId = 1;
  constructor(private readonly idPrefix: string) {}

  newId(): string {
    const id = `${this.idPrefix}${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  put(path: string, bytes: Uint8Array, modifiedAt: number): StoredFile {
    const existing = this.files.get(path);
    const file = { id: existing?.id ?? this.newId(), bytes: new Uint8Array(bytes), modifiedAt };
    this.files.set(path, file);
    return file;
  }

  isFolder(path: string): boolean {
    if (path === '') return true;
    for (const key of this.files.keys()) {
      if (key.startsWith(`${path}/`)) return true;
    }
    return false;
  }

  folderId(path: string): string {
    return `${this.idPrefix}folder:${path}`;
  }

  /** Direct children of `folder` as Graph driveItems, names in code-unit order. */
  children(folder: string): Record<string, unknown>[] {
    const base = folder === '' ? '' : `${folder}/`;
    const folders = new Map<string, number>();
    const files: Record<string, unknown>[] = [];
    for (const [path, file] of this.files) {
      if (!path.startsWith(base)) continue;
      const rest = path.slice(base.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.push(this.fileItem(path, file));
      } else {
        const name = rest.slice(0, slash);
        folders.set(name, (folders.get(name) ?? 0) + 1);
      }
    }
    const folderItems = [...folders.entries()].map(([name, count]) => ({
      id: this.folderId(`${base}${name}`),
      name,
      size: 0,
      folder: { childCount: count },
      lastModifiedDateTime: new Date(0).toISOString(),
    }));
    const byName = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      compareCodeUnits(String(a['name']), String(b['name']));
    return [...folderItems.sort(byName), ...files.sort(byName)];
  }

  fileItem(path: string, file: StoredFile): Record<string, unknown> {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return {
      id: file.id,
      name,
      size: file.bytes.byteLength,
      file: { mimeType: 'application/octet-stream' },
      lastModifiedDateTime: new Date(file.modifiedAt).toISOString(),
    };
  }

  findById(id: string): { path: string; file?: StoredFile } | null {
    const prefix = `${this.idPrefix}folder:`;
    if (id.startsWith(prefix)) return { path: id.slice(prefix.length) };
    for (const [path, file] of this.files) {
      if (file.id === id) return { path, file };
    }
    return null;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function graphError(status: number, code: string, message: string): FakeResponse {
  return json(status, { error: { code, message } });
}

function bytesResponse(bytes: Uint8Array): FakeResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  };
}

/** Splits `/v1.0/me/drive/special/approot:/a/b:/content` into `{ path: 'a/b', suffix: '/content' }`. */
function parseApprootPath(pathname: string): { path: string; suffix: string } | null {
  const root = '/v1.0/me/drive/special/approot';
  if (!pathname.startsWith(root)) return null;
  const rest = pathname.slice(root.length);
  if (!rest.startsWith(':/')) return { path: '', suffix: rest };
  const close = rest.indexOf(':', 2);
  const encoded = close === -1 ? rest.slice(2) : rest.slice(2, close);
  const suffix = close === -1 ? '' : rest.slice(close + 1);
  const path = encoded
    .split('/')
    .map((s) => decodeURIComponent(s))
    .join('/');
  return { path, suffix };
}

export interface FakeGraphOptions {
  /** Access tokens Graph accepts (default `['graph-token-1']`). */
  validTokens?: string[];
  /** Children page size (forces `@odata.nextLink` paging in tests). */
  pageSize?: number;
  now?: () => number;
}

export class FakeGraphServer {
  readonly appFolder = new FakeTree('app-');
  readonly drive = new FakeTree('drv-');
  readonly validTokens: Set<string>;
  readonly log: FakeRequest[] = [];
  /** Requests that wrongly sent `Authorization` to a pre-authenticated URL. */
  readonly authLeaks: string[] = [];
  readonly uploadedFragments: { start: number; end: number; total: number }[] = [];
  private readonly faults: FakeFault[] = [];
  private readonly sessions = new Map<string, UploadSession>();
  private nextSession = 1;
  private readonly pageSize: number;
  private readonly now: () => number;

  constructor(options: FakeGraphOptions = {}) {
    this.validTokens = new Set(options.validTokens ?? ['graph-token-1']);
    this.pageSize = options.pageSize ?? 200;
    this.now = options.now ?? (() => Date.now());
  }

  inject(fault: FakeFault): void {
    this.faults.push({ times: 1, ...fault });
  }

  /** `fetch`-compatible adapter for unit tests. */
  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    const res = await this.handle({ method: request.method, url: request.url, headers, body });
    const nullBody = res.status === 204 || res.status === 304;
    return new Response(nullBody ? null : toArrayBuffer(res.body), {
      status: res.status,
      headers: res.headers,
    });
  };

  async handle(req: FakeRequest): Promise<FakeResponse> {
    this.log.push(req);
    const fault = this.takeFault(req);
    if (fault && !fault.applyThenFail) return this.faultResponse(fault);
    const res = await this.route(req);
    return fault ? this.faultResponse(fault) : res;
  }

  private faultResponse(fault: FakeFault): FakeResponse {
    return {
      ...graphError(fault.status, 'injectedFault', 'Injected'),
      headers: fault.headers ?? {},
    };
  }

  private async route(req: FakeRequest): Promise<FakeResponse> {
    const url = new URL(req.url);
    if (url.origin === FAKE_DOWNLOAD_ORIGIN) return this.handleDownload(req, url);
    if (url.origin === FAKE_UPLOAD_ORIGIN) return this.handleUploadSession(req, url);
    if (!this.isAuthorized(req)) {
      return graphError(401, 'InvalidAuthenticationToken', 'Access token is empty or invalid.');
    }
    const approot = parseApprootPath(url.pathname);
    if (approot) return this.handleApproot(req, url, approot.path, approot.suffix);
    return this.handleDrive(req, url);
  }

  private takeFault(req: FakeRequest): FakeFault | null {
    const idx = this.faults.findIndex((f) => f.match(req));
    if (idx === -1) return null;
    const fault = this.faults[idx] as FakeFault;
    const remaining = (fault.times ?? 1) - 1;
    if (remaining <= 0) this.faults.splice(idx, 1);
    else fault.times = remaining;
    return fault;
  }

  private isAuthorized(req: FakeRequest): boolean {
    const header = req.headers['authorization'] ?? '';
    return header.startsWith('Bearer ') && this.validTokens.has(header.slice(7));
  }

  private handleApproot(req: FakeRequest, url: URL, path: string, suffix: string): FakeResponse {
    if (req.method === 'GET' && suffix === '/children') {
      return this.listChildren(this.appFolder, path, url);
    }
    if (req.method === 'GET' && suffix === '') return this.itemMetadata(this.appFolder, path);
    if (req.method === 'PUT' && suffix === '/content') return this.simpleUpload(req, url, path);
    if (req.method === 'POST' && suffix === '/createUploadSession') {
      return this.createSession(req, path);
    }
    return graphError(400, 'invalidRequest', `Unsupported ${req.method} ${url.pathname}`);
  }

  private handleDrive(req: FakeRequest, url: URL): FakeResponse {
    const p = url.pathname;
    if (req.method !== 'GET') return graphError(405, 'notAllowed', 'Method not allowed');
    if (p === '/v1.0/me/drive/root/children') return this.listChildren(this.drive, '', url);
    const match = /^\/v1\.0\/me\/drive\/items\/([^/]+)(\/children)?$/.exec(p);
    if (!match?.[1]) return graphError(404, 'itemNotFound', 'Unknown endpoint');
    const found = this.drive.findById(decodeURIComponent(match[1]));
    if (!found) return graphError(404, 'itemNotFound', 'Item not found');
    if (match[2]) return this.listChildren(this.drive, found.path, url);
    return this.itemMetadata(this.drive, found.path);
  }

  private listChildren(tree: FakeTree, folder: string, url: URL): FakeResponse {
    if (!tree.isFolder(folder)) return graphError(404, 'itemNotFound', 'Folder not found');
    const all = tree.children(folder);
    const skip = Number.parseInt(url.searchParams.get('$skiptoken') ?? '0', 10) || 0;
    const page = all.slice(skip, skip + this.pageSize);
    const next = skip + this.pageSize < all.length ? new URL(url.toString()) : null;
    next?.searchParams.set('$skiptoken', String(skip + this.pageSize));
    return json(200, { value: page, ...(next ? { '@odata.nextLink': next.toString() } : {}) });
  }

  private itemMetadata(tree: FakeTree, path: string): FakeResponse {
    const file = tree.files.get(path);
    if (!file) {
      if (path !== '' && tree.isFolder(path)) {
        return json(200, { id: tree.folderId(path), name: path, folder: { childCount: 1 } });
      }
      return graphError(404, 'itemNotFound', 'The resource could not be found.');
    }
    return json(200, {
      ...tree.fileItem(path, file),
      '@microsoft.graph.downloadUrl': `${FAKE_DOWNLOAD_ORIGIN}/${file.id}?tempauth=x`,
    });
  }

  private handleDownload(req: FakeRequest, url: URL): FakeResponse {
    if (req.headers['authorization']) this.authLeaks.push(req.url);
    const id = url.pathname.slice(1);
    const found = this.appFolder.findById(id) ?? this.drive.findById(id);
    if (!found?.file) return graphError(404, 'itemNotFound', 'Download URL expired');
    return bytesResponse(found.file.bytes);
  }

  private simpleUpload(req: FakeRequest, url: URL, path: string): FakeResponse {
    const body = req.body ?? new Uint8Array();
    if (body.byteLength > SIMPLE_UPLOAD_LIMIT) {
      return graphError(413, 'requestTooLarge', 'Use an upload session for files over 4 MB.');
    }
    const behavior = url.searchParams.get('@microsoft.graph.conflictBehavior') ?? 'replace';
    if (behavior === 'fail' && this.appFolder.files.has(path)) {
      return graphError(409, 'nameAlreadyExists', 'The specified item name already exists.');
    }
    const file = this.appFolder.put(path, body, this.now());
    return json(201, this.appFolder.fileItem(path, file));
  }

  private createSession(req: FakeRequest, path: string): FakeResponse {
    const parsed = JSON.parse(new TextDecoder().decode(req.body ?? new Uint8Array())) as {
      item?: Record<string, unknown>;
    };
    const behavior = String(parsed.item?.['@microsoft.graph.conflictBehavior'] ?? 'replace');
    if (behavior === 'fail' && this.appFolder.files.has(path)) {
      return graphError(409, 'nameAlreadyExists', 'The specified item name already exists.');
    }
    const id = `s${this.nextSession}`;
    this.nextSession += 1;
    this.sessions.set(id, {
      path,
      conflictBehavior: behavior,
      total: null,
      received: [],
      receivedBytes: 0,
    });
    return json(200, {
      uploadUrl: `${FAKE_UPLOAD_ORIGIN}/${id}`,
      expirationDateTime: new Date(this.now() + 3_600_000).toISOString(),
    });
  }

  private handleUploadSession(req: FakeRequest, url: URL): FakeResponse {
    if (req.headers['authorization']) this.authLeaks.push(req.url);
    const id = url.pathname.slice(1);
    const session = this.sessions.get(id);
    if (!session) return graphError(404, 'itemNotFound', 'Upload session not found');
    if (req.method === 'DELETE') {
      this.sessions.delete(id);
      return { status: 204, headers: {}, body: new Uint8Array() };
    }
    if (req.method === 'GET') {
      return json(200, { nextExpectedRanges: [`${session.receivedBytes}-`] });
    }
    return this.acceptFragment(id, session, req);
  }

  private acceptFragment(id: string, session: UploadSession, req: FakeRequest): FakeResponse {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] ?? '');
    const body = req.body ?? new Uint8Array();
    if (!match) return graphError(400, 'invalidRange', 'Missing Content-Range');
    const [start, end, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const isLast = end + 1 === total;
    if (start !== session.receivedBytes) {
      return graphError(416, 'invalidRange', 'Fragment does not start at the next expected byte');
    }
    if (body.byteLength !== end - start + 1 || (!isLast && body.byteLength % FRAGMENT_UNIT !== 0)) {
      return graphError(400, 'invalidRange', 'Fragment size must be a multiple of 320 KiB');
    }
    this.uploadedFragments.push({ start, end, total });
    session.total = total;
    session.received.push(new Uint8Array(body));
    session.receivedBytes += body.byteLength;
    if (!isLast) return json(202, { nextExpectedRanges: [`${session.receivedBytes}-`] });
    this.sessions.delete(id);
    if (session.conflictBehavior === 'fail' && this.appFolder.files.has(session.path)) {
      return graphError(409, 'nameAlreadyExists', 'The specified item name already exists.');
    }
    const joined = new Uint8Array(session.receivedBytes);
    let offset = 0;
    for (const part of session.received) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    const file = this.appFolder.put(session.path, joined, this.now());
    return json(201, this.appFolder.fileItem(session.path, file));
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Matcher helper: `method` plus a substring of the request path (decoded). */
export function requestMatches(method: string, pathPart: string): (req: FakeRequest) => boolean {
  return (req) =>
    req.method === method && decodeURIComponent(new URL(req.url).pathname).includes(pathPart);
}
