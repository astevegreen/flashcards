import { getTotalAppliedEventCount, type CollectionState } from '../events/replay.ts';
import { sanitizeDeviceId } from '../sync/codec.ts';
import type { BackupKind, BackupManifest } from './archive.ts';

/** How many snapshots a device keeps (the newest full one is kept on top when it is older). */
export const BACKUP_KEEP_COUNT = 14;
/** A new automatic snapshot once the newest is this old ("about once a day when the app is used"). */
export const BACKUP_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** A full snapshot (with media) once the newest full one is this old. */
export const FULL_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Above this much media a snapshot stays daily (no media): the media store and the sync folder
 * still hold the files. Matches the `.flashpkg` import cap, so a full snapshot stays importable.
 */
export const FULL_BACKUP_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

type BackupLike = Pick<BackupManifest, 'backup_id' | 'created_at' | 'kind' | 'media_included'> &
  Partial<Pick<BackupManifest, 'total_events' | 'collection_id' | 'media_hashes'>>;

function newestFirst<T extends BackupLike>(backups: readonly T[]): T[] {
  return [...backups].sort(
    (a, b) => b.created_at - a.created_at || (a.backup_id < b.backup_id ? 1 : -1),
  );
}

/**
 * True when an automatic snapshot should be taken now: the collection is not empty, the newest
 * snapshot is older than {@link BACKUP_INTERVAL_MS} (or stamped far in the future by a wrong
 * clock), and the collection changed since it.
 */
export function isAutoBackupDue(
  backups: readonly BackupLike[],
  state: CollectionState,
  nowMs: number,
  collectionId?: string,
): boolean {
  if (state.decks.size === 0 && state.notes.size === 0) return false;
  const newest = newestFirst(backups)[0];
  if (!newest) return true;
  const age = nowMs - newest.created_at;
  const clockSkewed = age < -BACKUP_INTERVAL_MS;
  if (age < BACKUP_INTERVAL_MS && !clockSkewed) return false;
  const unchanged =
    newest.total_events === getTotalAppliedEventCount(state) &&
    newest.collection_id === collectionId;
  return !unchanged;
}

/** Full (with media) when the newest full snapshot is a week old, unless the media is too large. */
export function chooseBackupKind(
  backups: readonly BackupLike[],
  totalMediaBytes: number,
  nowMs: number,
): BackupKind {
  if (totalMediaBytes <= 0 || totalMediaBytes > FULL_BACKUP_MAX_MEDIA_BYTES) return 'daily';
  const newestFull = newestFirst(backups).find((b) => b.media_included);
  if (!newestFull) return 'full';
  const age = nowMs - newestFull.created_at;
  return age >= FULL_BACKUP_INTERVAL_MS || age < -FULL_BACKUP_INTERVAL_MS ? 'full' : 'daily';
}

/** Ids to delete: everything past the newest `keep`, except the newest full snapshot. */
export function selectBackupsToPrune(
  backups: readonly BackupLike[],
  keep: number = BACKUP_KEEP_COUNT,
): string[] {
  const sorted = newestFirst(backups);
  const newestFull = sorted.find((b) => b.media_included);
  return sorted
    .slice(Math.max(0, keep))
    .filter((b) => b !== newestFull)
    .map((b) => b.backup_id);
}

/** Every media hash a kept snapshot lists: media cleanup must never remove these. */
export function mediaHashesUsedByBackups(backups: readonly BackupLike[]): Set<string> {
  const used = new Set<string>();
  for (const b of backups) for (const h of b.media_hashes ?? []) used.add(h.toLowerCase());
  return used;
}

/** Folder of snapshot copies in the sync store (beside `sync/v1/`, never read by the sync engine). */
export const SYNC_FOLDER_BACKUP_PREFIX = 'backups/v1/';

/**
 * Path of this device's snapshot copy in the sync folder. Seven slots, one per weekday (UTC):
 * each copy overwrites the one from a week before, so the folder keeps the last 7 days per
 * device without the transport needing a delete.
 */
export function syncFolderBackupPath(deviceId: string, nowMs: number): string {
  const day = new Date(nowMs).getUTCDay();
  return `${SYNC_FOLDER_BACKUP_PREFIX}${sanitizeDeviceId(deviceId)}/day-${day}.flashpkg`;
}

/** Parses a path written by {@link syncFolderBackupPath}; `null` for anything else. */
export function parseSyncFolderBackupPath(path: string): { deviceId: string; day: number } | null {
  if (!path.startsWith(SYNC_FOLDER_BACKUP_PREFIX)) return null;
  const match = /^([a-zA-Z0-9._-]{1,128})\/day-([0-6])\.flashpkg$/.exec(
    path.slice(SYNC_FOLDER_BACKUP_PREFIX.length),
  );
  if (!match?.[1] || match[1] === '.' || match[1] === '..') return null;
  return { deviceId: match[1], day: Number(match[2]) };
}
