import type { FileSink } from '@flash/platform';

/** The slice of `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs` that a streamed save uses. */
export interface TauriStreamDeps {
  save(opts: { defaultPath: string }): Promise<string | null>;
  writeFile(path: string, data: Uint8Array, opts?: { append?: boolean }): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * Asks where to save, then appends each chunk to that file. `null` when the user cancels.
 * `abort` deletes the partial file.
 */
export async function openTauriSaveStream(
  deps: TauriStreamDeps,
  filename: string,
): Promise<FileSink | null> {
  const target = await deps.save({ defaultPath: filename });
  if (!target) return null;
  let started = false;
  let done = false;
  async function put(chunk: Uint8Array): Promise<void> {
    // The first write creates or truncates the file; later ones append.
    const append = started;
    started = true;
    await deps.writeFile(target as string, chunk, { append });
  }
  return {
    async write(chunk) {
      if (chunk.length > 0) await put(chunk);
    },
    async close() {
      if (!started) await put(new Uint8Array(0));
      done = true;
    },
    async abort() {
      if (done || !started) return;
      done = true;
      await deps.remove(target).catch(() => undefined);
    },
  };
}
