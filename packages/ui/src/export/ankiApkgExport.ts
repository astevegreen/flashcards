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
 * `.apkg` export of the given decks (notes, media, tags; every card new). The SQLite file is
 * written by the platform's lazy Anki service (`writeCollection`). Returns the status message to show.
 */
export async function exportAnkiApkg(
  platform: PlatformServices,
  state: CollectionState,
  options: { deckIds: readonly string[]; name?: string },
): Promise<string> {
  const [{ planAnkiApkgExport, assembleApkg }, reader] = await Promise.all([
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
  const media = await readMedia(
    platform,
    plan.media.map((m) => m.hash),
  );
  const result = assembleApkg(collection, plan, media);
  await platform.files.downloadFile(plan.fileName, result.bytes, 'application/octet-stream');
  const files = result.mediaCount > 0 ? ` and ${result.mediaCount} media file(s)` : '';
  const warnings = plan.warnings.length > 0 ? ` ${plan.warnings.join(' ')}` : '';
  return `Exported ${notesText(plan.noteCount)}${files} to ${plan.fileName}. Open it with Anki to import it.${missingText(result.missingMediaCount)}${warnings}`;
}
