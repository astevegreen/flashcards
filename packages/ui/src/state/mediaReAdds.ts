import {
  newlyReferencedMedia,
  type CollectionState,
  type KnownEvent,
  type MediaEntry,
  type MediaRefSource,
} from '@flash/core';
import type { Storage } from '@flash/platform';
import { storedMediaEntries } from './storedMedia.ts';

/**
 * The media to add again after a batch of edits (lazy chunk): every file the batch starts to use
 * (see `newlyReferencedMedia`), so the newer use beats a `MediaRemoved` another device decided
 * before the edit synced. A file the collection still lists is re-added as it is listed; one it
 * no longer lists (a removal already won) is re-added from the file this device stores, if any.
 */
export async function planMediaReAdds(
  prior: MediaRefSource,
  events: readonly KnownEvent[],
  state: CollectionState,
  storage: Pick<Storage, 'getMedia'>,
): Promise<MediaEntry[]> {
  const hashes = newlyReferencedMedia(prior, events);
  const out: MediaEntry[] = [];
  const absent: string[] = [];
  for (const hash of hashes) {
    const m = state.media.get(hash);
    if (m) out.push({ hash: m.hash, ext: m.ext, mime: m.mime, size: m.size });
    else absent.push(hash);
  }
  if (absent.length > 0) out.push(...(await storedMediaEntries(storage, absent)));
  return out;
}
