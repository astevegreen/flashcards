import type { PlatformServices } from '@flash/platform';
import { ExportCancelledError } from './exportCancelled.ts';

/**
 * Streams a zip from the Anki writers to the platform and saves it. Lazily imported by the two
 * export modules, so it stays out of the study-screen bundle (§8).
 *
 * Web (`downloadBlob`): each chunk goes into its own Blob as it arrives, so the media read for
 * the zip can be freed file by file; the browser keeps large Blobs out of the JS heap.
 * Native with `saveStream`: chunks are written to a file in order. Otherwise one array at the end.
 */
export async function saveStreamedZip<R extends { fileName: string }>(
  platform: PlatformServices,
  mimeType: string,
  fileName: string,
  write: (emit: (chunk: Uint8Array) => void | Promise<void>) => Promise<R>,
): Promise<R> {
  if (!platform.files.downloadBlob && platform.files.saveStream) {
    const sink = await platform.files.saveStream(fileName, mimeType);
    if (!sink) throw new ExportCancelledError();
    // Writes are chained on `queue`, one awaited at a time. `emit` returns the queue, and the
    // zip writers wait for it before reading the next media file (backpressure), so a disk slower
    // than the zip never piles chunks up in memory.
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
