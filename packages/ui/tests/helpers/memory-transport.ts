import { SyncTransportError } from '@flash/core';

/** An in-memory `SyncTransport` that records writes; `onRead` lets a test act mid-sync. */
export function memoryTransport() {
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const transport = {
    files,
    writes,
    onRead: (_path: string) => {},
    async list(prefix: string) {
      return [...files.entries()]
        .filter(([p]) => p.startsWith(prefix))
        .map(([path, d]) => ({ path, size: d.byteLength, updatedAt: 1 }));
    },
    async read(path: string) {
      transport.onRead(path);
      const d = files.get(path);
      if (!d) throw new SyncTransportError('NOT_FOUND', path);
      return d;
    },
    async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }) {
      if (opts?.ifAbsent && files.has(path)) throw new SyncTransportError('ALREADY_EXISTS', path);
      writes.push(path);
      files.set(path, data);
    },
    async delete(path: string) {
      files.delete(path);
    },
  };
  return transport;
}
