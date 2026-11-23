import type { PlatformServices } from '@flash/platform';

/** The user closed the save dialog. Callers show it as a status, not as an error. */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'ExportCancelledError';
  }
}

/** True for `ExportCancelledError`, checked by name so callers need not import this module. */
export function isExportCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExportCancelledError';
}

/**
 * Streams a zip from the Anki writers to the platform and saves it. Lazily imported by the two
 * export modules, so it stays out of the study-screen bundle (§8).
 *
 * Web (`downloadBlob`): each chunk goes into its own Blob as it arrives, so the media read for
 * the zip can be freed file by file; the browser keeps large Blobs out of the JS heap.
 * Native with `saveStream`: chunks are written to a file in order. Otherwise one array at the end.
 */
/** Slice size when {@link saveBytes} hands a finished array to a native file sink. */
const SAVE_SLICE_BYTES = 512 * 1024;

/**
 * Saves bytes that already exist as one array. Native shells with `saveStream` get them in
 * 512 KB slices (no single bridge call carries the whole file); web and the rest use
 * `downloadFile` as before.
 */
export async function saveBytes(
  platform: PlatformServices,
  fileName: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<void> {
  if (platform.files.downloadBlob || !platform.files.saveStream) {
    await platform.files.downloadFile(fileName, bytes, mimeType);
    return;
  }
  await saveStreamedZip(platform, mimeType, fileName, async (emit) => {
    for (let at = 0; at < bytes.byteLength; at += SAVE_SLICE_BYTES) {
      await emit(bytes.subarray(at, Math.min(at + SAVE_SLICE_BYTES, bytes.byteLength)));
    }
    return { fileName };
  });
}

export async function saveStreamedZip<R extends { fileName: string }>(
  platform: PlatformServices,
  mimeType: string,
  fileName: string,
  write: (emit: (chunk: Uint8Array) => void | Promise<void>) => Promise<R>,
): Promise<R> {
  if (!platform.files.downloadBlob && platform.files.saveStream) {
    const sink = await platform.files.saveStream(fileName, mimeType);
    if (!sink) throw new ExportCancelledError();
    // Writes are chained on `queue`, one at a time. `emit` returns the queue, and the zip
    // writers wait for it before reading the next media file, so at most one file's chunks
    // wait in memory when the disk is slower than the zip.
    let queue: Promise<void> = Promise.resolve();
    let failure: unknown;
    let failed = false;
    try {
      const result = await write((chunk) => {
        // Stop zipping the rest of the media once a write has failed.
        if (failed) throw failure;
        queue = queue
          .then(() => (failed ? undefined : sink.write(chunk)))
          .catch((err: unknown) => {
            failed = true;
            failure = err;
          });
        return queue;
      });
      await queue;
      if (failed) throw failure;
      await sink.close();
      return result;
    } catch (err) {
      failed = true;
      // Let queued writes settle first, so none lands after the abort.
      await queue;
      await sink.abort().catch(() => undefined);
      throw err;
    }
  }
  const parts: Blob[] = [];
  const result = await write((chunk) => {
    parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]));
  });
  const blob = new Blob(parts, { type: mimeType });
  parts.length = 0;
  if (platform.files.downloadBlob) {
    await platform.files.downloadBlob(result.fileName, blob);
  } else {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await platform.files.downloadFile(result.fileName, bytes, mimeType);
  }
  return result;
}
