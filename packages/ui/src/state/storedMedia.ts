import { safeMediaExtForMime, type MediaEntry } from '@flash/core';
import type { Storage } from '@flash/platform';

/**
 * Media entries for `hashes` this device still stores, read from the files themselves. Files of a
 * type the app doesn't accept (§13) are skipped. Used for edits that use a removed file, and for
 * Re-add in Check media.
 */
export async function storedMediaEntries(
  storage: Pick<Storage, 'getMedia'>,
  hashes: readonly string[],
): Promise<MediaEntry[]> {
  const out: MediaEntry[] = [];
  for (const hash of hashes) {
    const blob = await storage.getMedia(hash);
    if (!blob) continue;
    const ext = safeMediaExtForMime(blob.mime);
    if (!ext) continue;
    out.push({ hash: hash.toLowerCase(), ext, mime: blob.mime, size: blob.bytes.byteLength });
  }
  return out;
}
