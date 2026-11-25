/**
 * In-memory fake Dropbox App Folder API v2 server for unit and Playwright e2e tests.
 * Supports `/2/files/list_folder`, `/2/files/list_folder/continue`, `/2/files/get_metadata`,
 * `/2/files/download`, and `/2/files/upload`.
 */

export interface FakeDropboxFile {
  id: string;
  pathDisplay: string;
  pathLower: string;
  name: string;
  bytes: Uint8Array;
  rev: string;
  contentHash: string;
  serverModified: string;
}

export interface FakeDropboxRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface FakeDropboxResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function simpleHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (b + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`.repeat(4);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function jsonResponse(status: number, data: unknown): FakeDropboxResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: enc.encode(JSON.stringify(data)),
  };
}

export class FakeDropboxServer {
  readonly files = new Map<string, FakeDropboxFile>();
  private nextId = 1;
  private revCounter = 1;
  private readonly pageSize: number;
  private readonly cursors = new Map<string, unknown[]>();
  private injected: Array<{
    match: (req: FakeDropboxRequest) => boolean;
    status: number;
    body?: unknown;
  }> = [];

  constructor(options?: { pageSize?: number }) {
    this.pageSize = options?.pageSize ?? 50;
  }

  inject(rule: { match: (req: FakeDropboxRequest) => boolean; status: number; body?: unknown }) {
    this.injected.push(rule);
  }

  put(relPath: string, bytes: Uint8Array, mtimeMs = Date.now()): FakeDropboxFile {
    const clean = relPath.replaceAll('\\', '/').replace(/^\/+/, '');
    const pathDisplay = `/${clean}`;
    const pathLower = pathDisplay.toLowerCase();
    const name = clean.split('/').pop() ?? clean;
    const existing = this.files.get(pathLower);
    const id = existing?.id ?? `id:dbx-${this.nextId++}`;
    const rev = `rev-${this.revCounter++}`;
    const copy = new Uint8Array(bytes);
    const entry: FakeDropboxFile = {
      id,
      pathDisplay,
      pathLower,
      name,
      bytes: copy,
      rev,
      contentHash: simpleHash(copy),
      serverModified: new Date(mtimeMs).toISOString(),
    };
    this.files.set(pathLower, entry);
    return entry;
  }

  findByIdOrPath(selector: string): FakeDropboxFile | undefined {
    if (selector.startsWith('id:')) {
      for (const f of this.files.values()) {
        if (f.id === selector) return f;
      }
      return undefined;
    }
    const clean = selector.startsWith('/') ? selector.toLowerCase() : `/${selector.toLowerCase()}`;
    return this.files.get(clean);
  }

  private toFileEntry(f: FakeDropboxFile) {
    return {
      '.tag': 'file',
      id: f.id,
      name: f.name,
      path_display: f.pathDisplay,
      path_lower: f.pathLower,
      size: f.bytes.byteLength,
      rev: f.rev,
      content_hash: f.contentHash,
      server_modified: f.serverModified,
    };
  }

  async handle(req: FakeDropboxRequest): Promise<FakeDropboxResponse> {
    for (const rule of this.injected) {
      if (rule.match(req)) {
        return jsonResponse(rule.status, rule.body ?? { error_summary: `injected_${rule.status}` });
      }
    }

    const authHeader = req.headers['authorization'] ?? req.headers['Authorization'] ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse(401, { error_summary: 'invalid_access_token' });
    }

    const pathname = new URL(req.url).pathname;

    if (pathname.endsWith('/files/list_folder')) {
      const body = JSON.parse(dec.decode(req.body ?? new Uint8Array())) as {
        path?: string;
        recursive?: boolean;
      };
      const prefix = trimTrailingSlashes((body.path ?? '').toLowerCase());
      const recursive = Boolean(body.recursive);
      const entries: unknown[] = [];
      const seenFolders = new Set<string>();

      for (const f of this.files.values()) {
        if (prefix && !f.pathLower.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? f.pathDisplay.slice(prefix.length + 1) : f.pathDisplay.slice(1);
        const parts = rest.split('/');
        if (parts.length === 1 || recursive) {
          entries.push(this.toFileEntry(f));
        } else {
          const folderName = parts[0] ?? '';
          const folderPathDisplay = prefix ? `${prefix}/${folderName}` : `/${folderName}`;
          const folderPathLower = folderPathDisplay.toLowerCase();
          if (!seenFolders.has(folderPathLower)) {
            seenFolders.add(folderPathLower);
            entries.push({
              '.tag': 'folder',
              id: `id:folder:${folderPathLower}`,
              name: folderName,
              path_display: folderPathDisplay,
              path_lower: folderPathLower,
            });
          }
        }
      }

      if (prefix && entries.length === 0) {
        return jsonResponse(409, { error_summary: 'path/not_found/.' });
      }

      const firstPage = entries.slice(0, this.pageSize);
      const remaining = entries.slice(this.pageSize);
      const cursor = `cur-${this.nextId++}`;
      if (remaining.length > 0) this.cursors.set(cursor, remaining);
      return jsonResponse(200, {
        entries: firstPage,
        cursor,
        has_more: remaining.length > 0,
      });
    }

    if (pathname.endsWith('/files/list_folder/continue')) {
      const body = JSON.parse(dec.decode(req.body ?? new Uint8Array())) as { cursor?: string };
      const all = this.cursors.get(body.cursor ?? '') ?? [];
      this.cursors.delete(body.cursor ?? '');
      const page = all.slice(0, this.pageSize);
      const remaining = all.slice(this.pageSize);
      const cursor = `cur-${this.nextId++}`;
      if (remaining.length > 0) this.cursors.set(cursor, remaining);
      return jsonResponse(200, {
        entries: page,
        cursor,
        has_more: remaining.length > 0,
      });
    }

    if (pathname.endsWith('/files/get_metadata')) {
      const body = JSON.parse(dec.decode(req.body ?? new Uint8Array())) as { path?: string };
      const found = this.findByIdOrPath(body.path ?? '');
      if (!found) return jsonResponse(409, { error_summary: 'path/not_found/.' });
      return jsonResponse(200, this.toFileEntry(found));
    }

    if (pathname.endsWith('/files/download')) {
      const apiArgRaw = req.headers['dropbox-api-arg'] ?? req.headers['Dropbox-API-Arg'] ?? '{}';
      const arg = JSON.parse(apiArgRaw) as { path?: string };
      const found = this.findByIdOrPath(arg.path ?? '');
      if (!found) return jsonResponse(409, { error_summary: 'path/not_found/.' });
      return {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'dropbox-api-result': JSON.stringify(this.toFileEntry(found)),
        },
        body: new Uint8Array(found.bytes),
      };
    }

    if (pathname.endsWith('/files/upload')) {
      const apiArgRaw = req.headers['dropbox-api-arg'] ?? req.headers['Dropbox-API-Arg'] ?? '{}';
      const arg = JSON.parse(apiArgRaw) as { path?: string; mode?: string };
      const path = arg.path ?? '';
      if (arg.mode === 'add' && this.findByIdOrPath(path)) {
        return jsonResponse(409, { error_summary: 'path/conflict/file/.' });
      }
      const saved = this.put(path, req.body ?? new Uint8Array());
      return jsonResponse(200, this.toFileEntry(saved));
    }

    return jsonResponse(404, { error_summary: `unknown_route:${pathname}` });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    let url: string;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
    }
    let body: Uint8Array | undefined;
    if (typeof init?.body === 'string') {
      body = enc.encode(init.body);
    } else if (init?.body instanceof ArrayBuffer) {
      body = new Uint8Array(init.body);
    } else if (ArrayBuffer.isView(init?.body)) {
      body = new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength);
    }
    const res = await this.handle({
      method: init?.method ?? 'GET',
      url,
      headers,
      ...(body ? { body } : {}),
    });
    const outCopy = new Uint8Array(res.body);
    return new Response(outCopy.buffer, { status: res.status, headers: res.headers });
  };
}
