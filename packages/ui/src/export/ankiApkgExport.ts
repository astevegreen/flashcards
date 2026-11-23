import type { CollectionState } from '@flash/core';
import type { PlatformServices } from '@flash/platform';

/**
 * ".apkg" export from the UI. Library deck options import this lazily, so it stays out of the
 * study-screen bundle (§8). It repeats the small helpers of `ankiExport.ts` on purpose: sharing
 * them would split a shared chunk and add a preload entry to the initial bundle.
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

function missingText(missing: number): string {
  return missing > 0
    ? ` ${missing} media file${missing === 1 ? ' is' : 's are'} not on this device and ${missing === 1 ? 'was' : 'were'} left out.`
    : '';
}

function fromAnkiText(count: number): string {
  if (count === 0) return '';
  const notes =
    count === 1
      ? '1 note came from Anki and keeps its Anki ID.'
      : `${count} notes came from Anki and keep their Anki IDs.`;
  return ` ${notes} In the profile it came from, Anki updates such notes only while their note type there still has the same fields and card types; otherwise tick "Merge note types" when importing, or Anki skips them.`;
}

/**
 * `.apkg` export of the given decks (notes, media, tags; every card new). The SQLite file is
 * written by the platform's lazy Anki service (`writeCollection`). Returns the status message
 * to show.
 */
export async function exportAnkiApkg(
  platform: PlatformServices,
  state: CollectionState,
  options: { deckIds: readonly string[]; name?: string },
): Promise<string> {
  const [{ planAnkiApkgExport, writeApkg }, reader] = await Promise.all([
    import('@flash/core/anki-export'),
    platform.getAnkiPackageReader?.(),
  ]);
  if (!reader?.writeCollection) {
    throw new Error('Export for Anki (.apkg) is not available on this device.');
  }
  const plan = planAnkiApkgExport(state, {
    deckIds: options.deckIds,
    ...(options.name ? { name: options.name } : {}),
  });
  const collection = await reader.writeCollection(plan.collection);
  const readMedia = async (hash: string) => (await platform.storage.getMedia(hash))?.bytes;
  const result = await saveStreamedZip(platform, 'application/octet-stream', (emit) =>
    writeApkg(collection, plan, readMedia, emit, { modifiedMs: Date.now() }),
  );
  const files = result.mediaCount > 0 ? ` and ${result.mediaCount} media file(s)` : '';
  const warnings = plan.warnings.length > 0 ? ` ${plan.warnings.join(' ')}` : '';
  return `Exported ${notesText(plan.noteCount)}${files} to ${result.fileName}. Open it with Anki to import it.${missingText(result.missingMediaCount)}${fromAnkiText(plan.fromAnkiNoteCount)}${warnings}`;
}
