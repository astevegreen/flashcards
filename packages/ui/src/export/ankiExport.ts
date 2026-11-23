import type { CollectionState } from '@flash/core';
import type { PlatformServices } from '@flash/platform';

/**
 * Export to Anki from the UI. Lazily imported by the export buttons, so neither this module nor
 * `@flash/core/anki-export` (zip writer included) reaches the study-screen bundle (§8).
 */

function notesText(n: number): string {
  return `${n} note${n === 1 ? '' : 's'}`;
}

/**
 * Streams a zip into Blob parts and saves it. Each chunk is copied into its own Blob as it
 * arrives, so the media read for the zip can be freed file by file; the browser keeps large
 * Blobs out of the JS heap. Platforms without `downloadBlob` get one array at the end.
 */
async function saveStreamedZip<R extends { fileName: string }>(
  platform: PlatformServices,
  mimeType: string,
  write: (emit: (chunk: Uint8Array) => void) => Promise<R>,
): Promise<R> {
  const parts: Blob[] = [];
  const result = await write((chunk) => parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>])));
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

/** Reads one media file (`undefined` when this device doesn't have it). */
function mediaReader(platform: PlatformServices) {
  return async (hash: string): Promise<Uint8Array | undefined> =>
    (await platform.storage.getMedia(hash))?.bytes;
}

function missingText(missing: number): string {
  return missing > 0
    ? ` ${missing} media file${missing === 1 ? ' is' : 's are'} not on this device and ${missing === 1 ? 'was' : 'were'} left out.`
    : '';
}

/**
 * "Export for Anki" CSV: one deck's notes as a zip of the CSV (with Anki's header lines), its
 * media and a README. Returns the status message to show.
 */
export async function exportAnkiCsvZip(
  platform: PlatformServices,
  state: CollectionState,
  options: { deckId: string; noteIds?: readonly string[]; includeArchived?: boolean },
): Promise<string> {
  const { planAnkiCsvExport, writeAnkiCsvZip } = await import('@flash/core/anki-export');
  const plan = planAnkiCsvExport(state, options);
  const result = await saveStreamedZip(platform, 'application/zip', (emit) =>
    writeAnkiCsvZip(plan, mediaReader(platform), emit, { modifiedMs: Date.now() }),
  );
  const files = result.mediaCount > 0 ? ` and ${result.mediaCount} media file(s)` : '';
  return `Exported ${notesText(plan.noteCount)}${files} to ${result.fileName}.${missingText(result.missingMediaCount)}`;
}
