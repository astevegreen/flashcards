import type { FileSink } from '@flash/platform';

/** The slice of `@capacitor/filesystem` and `@capacitor/share` that a streamed save uses. */
export interface CapacitorStreamDeps {
  writeFile(opts: { path: string; data: string }): Promise<{ uri: string }>;
  appendFile(opts: { path: string; data: string }): Promise<void>;
  deleteFile(opts: { path: string }): Promise<void>;
  share(opts: { title: string; uri: string }): Promise<void>;
}

/** Bridge calls cost more than bytes, so small chunks are joined up to about this size. */
const FLUSH_BYTES = 512 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

/**
 * Writes an export to a cache file in chunks (`appendFile`), then hands it to the share sheet on
 * `close`. `abort` deletes the partial file.
 */
export function createCapacitorSaveStream(deps: CapacitorStreamDeps, filename: string): FileSink {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let uri = '';
  let started = false;
  let closed = false;
  let shared = false;

  async function flush(): Promise<void> {
    if (pendingBytes === 0) return;
    const joined = new Uint8Array(pendingBytes);
    let at = 0;
    for (const part of pending) {
      joined.set(part, at);
      at += part.length;
    }
    pending = [];
    pendingBytes = 0;
    const data = bytesToBase64(joined);
    if (started) {
      await deps.appendFile({ path: filename, data });
    } else {
      started = true;
      uri = (await deps.writeFile({ path: filename, data })).uri;
    }
  }

  return {
    async write(chunk) {
      if (closed) throw new Error('The export file is already closed.');
      if (chunk.length === 0) return;
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= FLUSH_BYTES) await flush();
    },
    async close() {
      if (closed) throw new Error('The export file is already closed.');
      closed = true;
      await flush();
      if (!started) uri = (await deps.writeFile({ path: filename, data: '' })).uri;
      await deps.share({ title: filename, uri });
      shared = true;
    },
    async abort() {
      pending = [];
      pendingBytes = 0;
      closed = true;
      if (shared || !started) return;
      await deps.deleteFile({ path: filename }).catch(() => undefined);
    },
  };
}
