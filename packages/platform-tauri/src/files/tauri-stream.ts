import type { FileSink } from '@flash/platform';

/** The slice of `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs` that a streamed save uses. */
export interface TauriStreamDeps {
  save(opts: { defaultPath: string }): Promise<string | null>;
  writeFile(path: string, data: Uint8Array, opts?: { append?: boolean }): Promise<void>;
}

/**
 * Asks where to save, then appends each chunk to that file. `null` when the user cancels.
 * `abort` truncates the file to empty (no delete permission is granted in the user's folders).
 * Writes after `close` or `abort` are rejected.
 */
export async function openTauriSaveStream(
  deps: TauriStreamDeps,
  filename: string,
): Promise<FileSink | null> {
  const target = await deps.save({ defaultPath: filename });
  if (!target) return null;
  let started = false;
  let closed = false;
  async function put(chunk: Uint8Array): Promise<void> {
    // The first write creates or truncates the file; later ones append.
    const append = started;
    started = true;
    await deps.writeFile(target as string, chunk, { append });
  }
  return {
    async write(chunk) {
      if (closed) throw new Error('The export file is already closed.');
      if (chunk.length > 0) await put(chunk);
    },
    async close() {
      if (closed) throw new Error('The export file is already closed.');
      closed = true;
      if (!started) await deps.writeFile(target, new Uint8Array(0));
    },
    async abort() {
      if (closed) return;
      closed = true;
      if (started) await deps.writeFile(target, new Uint8Array(0)).catch(() => undefined);
    },
  };
}
