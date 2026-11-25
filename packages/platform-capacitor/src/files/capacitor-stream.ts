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

/** Subfolder inside `Directory.Cache` that holds temporary export files handed to the share sheet. */
export const EXPORT_CACHE_DIR = 'flashcards-exports';

/** Builds a cache-relative path inside `EXPORT_CACHE_DIR` for a temporary export file. */
export function exportCachePath(filename: string): string {
  const safeName = filename.replace(/[/\\]/g, '_');
  return `${EXPORT_CACHE_DIR}/${safeName}`;
}

export interface ExportCacheSweepDeps {
  readdir(opts: { path: string }): Promise<{ files: ReadonlyArray<{ name: string }> }>;
  deleteFile(opts: { path: string }): Promise<void>;
}

/**
 * Deletes leftover export files from previous app sessions in `EXPORT_CACHE_DIR`.
 * Called once at launch so files handed to the OS share sheet are never deleted while a share
 * target is still reading them, yet temp exports do not accumulate indefinitely.
 */
export async function sweepExportCache(deps: ExportCacheSweepDeps): Promise<number> {
  let entries: ReadonlyArray<{ name: string }>;
  try {
    entries = (await deps.readdir({ path: EXPORT_CACHE_DIR })).files;
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.name) continue;
    try {
      await deps.deleteFile({ path: `${EXPORT_CACHE_DIR}/${entry.name}` });
      removed += 1;
    } catch {
      // Best-effort cleanup; ignore individual file errors.
    }
  }
  return removed;
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
