/**
 * In-memory Google Drive `appDataFolder` for the `SyncTransport` contract suite: the files.list
 * name/trashed queries, `alt=media` reads, multipart create, media PATCH and DELETE that
 * `GoogleDriveAppDataTransport` sends. Like real Drive, create never fails on an existing name.
 */

interface FakeDriveFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  createdTime: string;
  modifiedTime: string;
  appProperties?: Record<string, string>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function parseMultipart(
  body: Uint8Array,
  contentType: string,
): { metadata: Record<string, unknown>; payload: Uint8Array } {
  const boundary = /boundary=([^\s;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error('Missing multipart boundary');
  const enc = new TextEncoder();
  const sep = enc.encode(`--${boundary}`);
  const blank = enc.encode('\r\n\r\n');
  const metaStart = indexOfBytes(body, blank, indexOfBytes(body, sep, 0)) + 4;
  const second = indexOfBytes(body, sep, metaStart);
  const metadata = JSON.parse(
    new TextDecoder().decode(body.subarray(metaStart, second - 2)),
  ) as Record<string, unknown>;
  const payloadStart = indexOfBytes(body, blank, second) + 4;
  const payloadEnd = indexOfBytes(body, enc.encode(`\r\n--${boundary}--`), payloadStart);
  return { metadata, payload: body.slice(payloadStart, payloadEnd) };
}

async function bodyBytes(init?: RequestInit): Promise<Uint8Array> {
  const body = init?.body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body ?? null).arrayBuffer());
}

export class FakeDriveServer {
  private readonly files = new Map<string, FakeDriveFile>();
  private nextId = 1;
  private clock = Date.parse('2026-01-01T00:00:00Z');

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private record(f: FakeDriveFile) {
    return {
      id: f.id,
      name: f.name,
      size: String(f.bytes.byteLength),
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      ...(f.appProperties ? { appProperties: f.appProperties } : {}),
    };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && path === '/drive/v3/files') {
      const q = url.searchParams.get('q') ?? '';
      const named = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const files = [...this.files.values()].filter((f) => named === undefined || f.name === named);
      return json({ files: files.map((f) => this.record(f)) });
    }
    if (path.startsWith('/drive/v3/files/')) {
      const id = decodeURIComponent(path.slice('/drive/v3/files/'.length));
      const found = this.files.get(id);
      if (!found) return json({ error: { code: 404, message: 'File not found' } }, 404);
      if (method === 'DELETE') {
        this.files.delete(id);
        return new Response(null, { status: 204 });
      }
      return new Response(found.bytes.slice(), { status: 200 });
    }
    if (method === 'POST' && path === '/upload/drive/v3/files') {
      const contentType = new Headers(init?.headers).get('Content-Type') ?? '';
      const { metadata, payload } = parseMultipart(await bodyBytes(init), contentType);
      const id = `drive-${this.nextId++}`;
      const now = this.tick();
      const appProperties = metadata['appProperties'] as Record<string, string> | undefined;
      this.files.set(id, {
        id,
        name: String(metadata['name']),
        bytes: payload,
        createdTime: now,
        modifiedTime: now,
        ...(appProperties ? { appProperties } : {}),
      });
      return json({ id, name: metadata['name'] });
    }
    if (method === 'PATCH' && path.startsWith('/upload/drive/v3/files/')) {
      const id = decodeURIComponent(path.slice('/upload/drive/v3/files/'.length));
      const found = this.files.get(id);
      if (!found) return json({ error: { code: 404, message: 'File not found' } }, 404);
      found.bytes = await bodyBytes(init);
      found.modifiedTime = this.tick();
      return json({ id });
    }
    return json({ error: { code: 400, message: `Unhandled ${method} ${path}` } }, 400);
  };
}
