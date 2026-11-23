import type { SerializedCollectionState } from './snapshot.ts';

/**
 * Version of `SerializedCollectionState`, kept apart from `snapshot.ts` so the sync engine can
 * check a snapshot without loading the serializer.
 *
 * 2: every media entry has its `media:<hash>:added` register (Check media). A version 1 snapshot
 * comes from a build without `MediaRemoved` and lacks those registers, so a removal could beat a
 * newer add on a device that starts from it (see {@link snapshotLacksMediaRecords}).
 */
export const SERIALIZED_STATE_FORMAT_VERSION = 2;

/**
 * True when `serialized` is from a build before media removal and holds media without an add
 * register. Hydrating it can't tell when each file was added, so a device that has the full event
 * log (or the cloud segments) should replay those instead. Hydration still works: it falls back to
 * `restoreMediaAddRecords` in `snapshot.ts`.
 */
export function snapshotLacksMediaRecords(serialized: SerializedCollectionState): boolean {
  if (serialized.formatVersion >= 2) return false;
  return serialized.media.some(
    (m) => serialized.fieldHlcs[`media:${m.hash.toLowerCase()}:added`] === undefined,
  );
}
