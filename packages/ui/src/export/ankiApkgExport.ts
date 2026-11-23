import type { CollectionState } from '@flash/core';
import type { PlatformServices } from '@flash/platform';
import { saveStreamedZip } from './saveStreamedZip.ts';

/**
 * ".apkg" export from the UI. Library deck options import this lazily, so it stays out of the
 * study-screen bundle (§8). It repeats the small helpers of `ankiExport.ts` on purpose: sharing
 * them would split a shared chunk and add a preload entry to the initial bundle.
 */

function notesText(n: number): string {
  return `${n} note${n === 1 ? '' : 's'}`;
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
 * `.apkg` export of the given decks (notes, media, tags, review history and scheduling). The SQLite file is
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
  const nowMs = Date.now();
  const plan = planAnkiApkgExport(state, {
    nowMs,
    deckIds: options.deckIds,
    ...(options.name ? { name: options.name } : {}),
  });
  const collection = await reader.writeCollection(plan.collection);
  const readMedia = async (hash: string) => (await platform.storage.getMedia(hash))?.bytes;
  const result = await saveStreamedZip(
    platform,
    'application/octet-stream',
    plan.fileName,
    (emit) => writeApkg(collection, plan, readMedia, emit, { modifiedMs: nowMs }),
  );
  const reviews =
    plan.reviewCount > 0
      ? ` ${plan.reviewCount} review${plan.reviewCount === 1 ? '' : 's'} and the cards' intervals came along.`
      : '';
  const files = result.mediaCount > 0 ? ` and ${result.mediaCount} media file(s)` : '';
  const warnings = plan.warnings.length > 0 ? ` ${plan.warnings.join(' ')}` : '';
  return `Exported ${notesText(plan.noteCount)}${files} to ${result.fileName}. Open it with Anki to import it.${reviews}${missingText(result.missingMediaCount)}${fromAnkiText(plan.fromAnkiNoteCount)}${warnings}`;
}
