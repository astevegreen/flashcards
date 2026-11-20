import type { SyncFileInfo, SyncTransport } from '@flash/platform';

interface StoredObject {
  data: Uint8Array;
  updatedAt: number;
}

/**
 * Pure in-memory SyncTransport for unit/property tests and isolated dev runs.
 */
export class InMemorySyncTransport implements SyncTransport {
  private readonly store = new Map<string, StoredObject>();

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const out: SyncFileInfo[] = [];
    for (const [path, obj] of this.store.entries()) {
      if (path.startsWith(prefix)) {
        out.push({ path, size: obj.data.byteLength, updatedAt: obj.updatedAt });
      }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const obj = this.store.get(path);
    if (!obj) {
      throw new Error(`SyncTransport: file not found at "${path}"`);
    }
    return new Uint8Array(obj.data);
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    if (opts?.ifAbsent && this.store.has(path)) {
      throw new Error(`SyncTransport: file already exists at "${path}"`);
    }
    this.store.set(path, { data: new Uint8Array(data), updatedAt: Date.now() });
  }
}

/**
 * Dev-mode SyncTransport backed by localStorage + BroadcastChannel so
 * `?device=a` and `?device=b` tabs in the same browser share a simulated sync store.
 */
export class DevChannelSyncTransport implements SyncTransport {
  private readonly keyPrefix: string;
  private readonly channel: BroadcastChannel | null;

  constructor(namespace = 'flashcards-dev-sync') {
    this.keyPrefix = `${namespace}:`;
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(namespace) : null;
  }

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const out: SyncFileInfo[] = [];
    if (typeof localStorage === 'undefined') return out;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(this.keyPrefix)) continue;
      const path = k.slice(this.keyPrefix.length);
      if (!path.startsWith(prefix)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { b64: string; updatedAt: number };
        out.push({
          path,
          size: Math.floor((parsed.b64.length * 3) / 4),
          updatedAt: parsed.updatedAt,
        });
      } catch {
        // Ignore malformed entries
      }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(this.keyPrefix + path) : null;
    if (!raw) {
      throw new Error(`DevChannelSyncTransport: file not found at "${path}"`);
    }
    const parsed = JSON.parse(raw) as { b64: string };
    const bin = atob(parsed.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    const key = this.keyPrefix + path;
    if (opts?.ifAbsent && localStorage.getItem(key) !== null) {
      throw new Error(`DevChannelSyncTransport: file already exists at "${path}"`);
    }
    let bin = '';
    for (let i = 0; i < data.length; i++) {
      bin += String.fromCharCode(data[i] ?? 0);
    }
    const payload = JSON.stringify({ b64: btoa(bin), updatedAt: Date.now() });
    localStorage.setItem(key, payload);
    this.channel?.postMessage({ type: 'write', path });
  }

  close(): void {
    this.channel?.close();
  }
}
