import type { CollectionState } from '@flash/core';
import type { PlatformServices } from '@flash/platform';

/**
 * Export to Anki from the UI. Lazily imported by the export buttons, so neither this module nor
 * `@flash/core/anki-export` (zip writer included) reaches the study-screen bundle (§8).
 */

function notesText(n: number): string {
  return `${n} note${n === 1 ? '' : 's'}`;
}

/** Media bytes for the given hashes (skips files this device doesn't have). */
async function readMedia(
  platform: PlatformServices,
  hashes: Iterable<string>,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const hash of hashes) {
    const blob = await platform.storage.getMedia(hash);
    if (blob) out.set(hash, blob.bytes);
  }
  return out;
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
  const { planAnkiCsvExport, zipAnkiCsvExport } = await import('@flash/core/anki-export');
  const plan = planAnkiCsvExport(state, options);
  const media = await readMedia(
    platform,
    plan.media.map((m) => m.hash),
  );
  const result = zipAnkiCsvExport(plan, media);
  await platform.files.downloadFile(result.fileName, result.zip, 'application/zip');
  const files = result.mediaCount > 0 ? ` and ${result.mediaCount} media file(s)` : '';
  return `Exported ${notesText(plan.noteCount)}${files} to ${result.fileName}.${missingText(result.missingMediaCount)}`;
}
