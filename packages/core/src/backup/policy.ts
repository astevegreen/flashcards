import { getTotalAppliedEventCount, type CollectionState } from '../events/replay.ts';
import { sanitizeDeviceId } from '../sync/codec.ts';
import type { BackupKind, BackupManifest } from './archive.ts';

/** How many rolling snapshots a device keeps (the newest full one is kept on top when older). */
export const BACKUP_KEEP_COUNT = 14;
/** Snapshots taken just before a restore, kept apart from the rolling ones. */
export const PRE_RESTORE_KEEP_COUNT = 3;
/** A new automatic snapshot once the newest is this old ("about once a day when the app is used"). */
export const BACKUP_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** A full snapshot (with media) once the newest full one is this old. */
export const FULL_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Above this much media a snapshot stays daily (no media): the media store and the sync folder
 * still hold the files. Matches the `.flashpkg` import cap, so a full snapshot stays importable.
 */
export const FULL_BACKUP_MAX_MEDIA_BYTES = 100 * 1024 * 1024;
/**
 * A snapshot stamped later than now plus this was taken while the clock was wrong. It is never
 * the reference for "due", and it ranks below every sanely stamped one: real time only moves
 * forward, so it was taken before them.
 */
export const BACKUP_FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

type BackupLike = Pick<BackupManifest, 'backup_id' | 'created_at' | 'kind' | 'media_included'> &
  Partial<Pick<BackupManifest, 'total_events' | 'collection_id' | 'media_hashes' | 'reason'>>;

function isFutureStamped(b: BackupLike, nowMs: number): boolean {
  return b.created_at > nowMs + BACKUP_FUTURE_TOLERANCE_MS;
}

function byStampDesc(a: BackupLike, b: BackupLike): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  if (a.backup_id === b.backup_id) return 0;
  return a.backup_id < b.backup_id ? 1 : -1;
}

/** Newest first in real time: sanely stamped ones by stamp, then future-stamped ones. */
function newestFirst<T extends BackupLike>(backups: readonly T[], nowMs: number): T[] {
  const sane = backups.filter((b) => !isFutureStamped(b, nowMs)).sort(byStampDesc);
  const future = backups.filter((b) => isFutureStamped(b, nowMs)).sort(byStampDesc);
  return [...sane, ...future];
}

function isRolling(b: BackupLike): boolean {
  return b.reason !== 'pre-restore';
}

/**
 * True when an automatic snapshot should be taken now: the collection is not empty, the newest
 * sanely stamped rolling snapshot is older than {@link BACKUP_INTERVAL_MS} (one stamped in the
 * future by a wrong clock never counts), and the collection changed since it.
 */
export function isAutoBackupDue(
  backups: readonly BackupLike[],
  state: CollectionState,
  nowMs: number,
  collectionId?: string,
): boolean {
  if (state.decks.size === 0 && state.notes.size === 0) return false;
  const newest = backups
    .filter((b) => isRolling(b) && !isFutureStamped(b, nowMs))
    .sort(byStampDesc)[0];
  if (!newest) return true;
  if (nowMs - newest.created_at < BACKUP_INTERVAL_MS) return false;
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
  const newestFull = backups
    .filter((b) => b.media_included && !isFutureStamped(b, nowMs))
    .sort(byStampDesc)[0];
  if (!newestFull) return 'full';
  return nowMs - newestFull.created_at >= FULL_BACKUP_INTERVAL_MS ? 'full' : 'daily';
}

export interface PruneOptions {
  /** Rolling snapshots to keep (default {@link BACKUP_KEEP_COUNT}). */
  keep?: number;
  /** Pre-restore snapshots to keep (default {@link PRE_RESTORE_KEEP_COUNT}). */
  keepPreRestore?: number;
  /** Clock used to rank future-stamped snapshots (default `Date.now()`). */
  nowMs?: number;
  /** Ids never pruned, such as the backup being restored. */
  protect?: Iterable<string>;
}

/**
 * Ids to delete: rolling snapshots past the newest `keep` (except the newest full one) and
 * pre-restore snapshots past the newest `keepPreRestore`. Pre-restore snapshots never take a
 * rolling slot, and protected ids are never returned.
 */
export function selectBackupsToPrune(
  backups: readonly BackupLike[],
  opts: PruneOptions = {},
): string[] {
  const nowMs = opts.nowMs ?? Date.now();
  const protect = new Set(opts.protect ?? []);
  const rolling = newestFirst(backups.filter(isRolling), nowMs);
  const preRestore = newestFirst(
    backups.filter((b) => !isRolling(b)),
    nowMs,
  );
  const newestFull = rolling.find((b) => b.media_included);
  const out = [
    ...rolling.slice(Math.max(0, opts.keep ?? BACKUP_KEEP_COUNT)).filter((b) => b !== newestFull),
    ...preRestore.slice(Math.max(0, opts.keepPreRestore ?? PRE_RESTORE_KEEP_COUNT)),
  ];
  return out.filter((b) => !protect.has(b.backup_id)).map((b) => b.backup_id);
}

/** True when some kept snapshot packs media (otherwise media lives only in the media store). */
export function anyBackupHoldsMedia(backups: readonly BackupLike[]): boolean {
  return backups.some((b) => b.media_included);
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
