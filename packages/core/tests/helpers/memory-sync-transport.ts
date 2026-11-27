import {
  SyncTransportError,
  type SyncFileInfo,
  type SyncStoreTransport,
} from '../../src/sync/types.ts';

/** An in-memory `SyncStoreTransport` with create-only writes and a read log. */
export class MemorySyncTransport implements SyncStoreTransport {
  readonly files = new Map<string, { data: Uint8Array; updatedAt: number }>();
  readonly readLog: string[] = [];
  private tick = 1;

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const out: SyncFileInfo[] = [];
    for (const [path, entry] of this.files.entries()) {
      if (path.startsWith(prefix)) {
        out.push({ path, size: entry.data.byteLength, updatedAt: entry.updatedAt });
      }
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async read(path: string): Promise<Uint8Array> {
    this.readLog.push(path);
    const entry = this.files.get(path);
    if (!entry) throw new SyncTransportError('NOT_FOUND', `Missing: ${path}`);
    return new Uint8Array(entry.data);
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    if (opts?.ifAbsent && this.files.has(path)) {
      throw new SyncTransportError('ALREADY_EXISTS', `Exists: ${path}`);
    }
    this.files.set(path, { data: new Uint8Array(data), updatedAt: this.tick++ });
  }
}
