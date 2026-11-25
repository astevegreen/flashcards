import type { MediaBlob, Storage } from '@flash/platform';

/**
 * Files this tab stored a short while ago (D16). An import stores its files seconds or minutes
 * before the `MediaAdded` events and the notes that use them, so a media check run in that gap
 * would see them as unused. "Remove unused files" leaves these alone.
 *
 * Per tab, in memory: a check in another tab of the same device during an import there is not
 * covered.
 */
export const RECENT_MEDIA_MS = 15 * 60_000;

const storedAt = new Map<string, number>();

/** Stores a file and remembers when, so a media check running meanwhile keeps it. */
export function putMediaTracked(storage: Storage, media: MediaBlob): Promise<void> {
  // Marked before the write, so a check that lists the file always sees the mark too.
  storedAt.set(media.hash.toLowerCase(), Date.now());
  return storage.putMedia(media);
}

/** Hashes stored by this tab within the last `RECENT_MEDIA_MS`. */
export function recentlyStoredMedia(nowMs: number = Date.now()): Set<string> {
  const recent = new Set<string>();
  for (const [hash, at] of storedAt) {
    if (nowMs - at < RECENT_MEDIA_MS && at <= nowMs) recent.add(hash);
    else if (nowMs - at >= RECENT_MEDIA_MS) storedAt.delete(hash);
  }
  return recent;
}

/** Tests only. */
export function resetRecentMediaForTests(): void {
  storedAt.clear();
}

/**
 * Stores files one at a time, tracked like `putMediaTracked`. Sequential on purpose: media can be
 * large, and one write in flight keeps memory and the native storage bridge in check.
 */
export async function putMediaListTracked(
  storage: Storage,
  media: Iterable<MediaBlob>,
): Promise<void> {
  for (const { hash, mime, bytes } of media) {
    await putMediaTracked(storage, { hash, mime, bytes }); // NOSONAR (S9382)
  }
}
