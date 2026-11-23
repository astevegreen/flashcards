import { zipSync } from 'fflate';
import type { CollectionState } from '../events/replay.ts';
import { getTotalAppliedEventCount } from '../events/replay.ts';
import {
  deserializeCollectionState,
  serializeCollectionState,
  SERIALIZED_STATE_FORMAT_VERSION,
  type SerializedCollectionState,
} from '../events/snapshot.ts';
import { decodeUtf8, encodeUtf8 } from '../ids.ts';
import { exportFlashpkgFiles } from '../import/flashpkg.ts';
import { safeMediaMimeForExt } from '../import/media-types.ts';
import { safeUnzip, type ArchiveLimits } from '../import/safe-unzip.ts';
import { sha256Hex } from '../sources/hash.ts';

/**
 * Rolling backups (automatic dated snapshots of the whole collection).
 *
 * A backup file is an ordinary `.flashpkg` (decks, notes, layouts, pages, courses: any build can
 * import it) plus two extra entries that importers ignore:
 * - `backup/backup.json`: the {@link BackupManifest};
 * - `backup/state.json`: the full `SerializedCollectionState`, with review history, archived
 *   notes and decks, suspensions, FSRS parameters and preferences. A restore reads this one.
 *
 * Daily snapshots carry no media: they list the content hashes they use (`media_hashes`) and rely
 * on the content-addressed media store. A periodic full snapshot also packs the media files.
 */

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MANIFEST_PATH = 'backup/backup.json';
export const BACKUP_STATE_PATH = 'backup/state.json';

export type BackupKind = 'daily' | 'full';
/** `auto` = the daily schedule; `manual` = "Back up now"; `pre-restore` = taken before a restore. */
export type BackupReason = 'auto' | 'manual' | 'pre-restore';

export interface BackupCounts {
  decks: number;
  notes: number;
  cards: number;
  reviews: number;
  media: number;
}

export interface BackupManifest {
  format_version: number;
  backup_id: string;
  kind: BackupKind;
  reason: BackupReason;
  created_at: number;
  device_id: string;
  collection_id?: string;
  /** Events applied to the collection when the snapshot was taken (grows with every change). */
  total_events: number;
  counts: BackupCounts;
  /** Every media hash the collection lists. Media cleanup must keep these while the backup is kept. */
  media_hashes: string[];
  /** True when the archive packs the media files (`media/<sha256>.<ext>`). */
  media_included: boolean;
}

/** A backup kept on this device: its manifest plus the archive size. */
export interface StoredBackupInfo extends BackupManifest {
  size_bytes: number;
}

export interface BuildBackupOptions {
  backupId: string;
  kind: BackupKind;
  reason: BackupReason;
  nowMs: number;
  deviceId: string;
  collectionId?: string;
  /** Sync watermarks merged into the serialized state (as local snapshots do). */
  watermarks?: Record<string, number>;
  /** Media blobs by hash. Used only for a `full` backup; a missing blob is left out. */
  mediaBlobs?: ReadonlyMap<string, Uint8Array>;
}

export interface BuiltBackup {
  manifest: BackupManifest;
  /** Archive entries without `backup/backup.json` and without media. */
  entries: Record<string, Uint8Array>;
  /** `media/<sha256>.<ext>` entries (empty for a daily backup). */
  mediaEntries: Record<string, Uint8Array>;
}

export class BackupArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupArchiveError';
  }
}

/** Caps for reading a backup archive (untrusted when the user picks a file, §13). */
export const BACKUP_ARCHIVE_LIMITS: ArchiveLimits = {
  maxFiles: 20_000,
  maxTotalUncompressedBytes: 400 * 1024 * 1024,
  maxSingleFileBytes: 200 * 1024 * 1024,
  maxCompressedBytes: 300 * 1024 * 1024,
};

function countReviews(state: CollectionState): number {
  let n = 0;
  for (const list of state.reviewsByCard.values()) {
    for (const r of list) if (!state.undoneReviewIds.has(r.review_id)) n += 1;
  }
  return n;
}

export function countBackupContents(state: CollectionState): BackupCounts {
  let decks = 0;
  for (const d of state.decks.values()) if (!d.archived) decks += 1;
  let notes = 0;
  for (const n of state.notes.values()) if (!n.archived) notes += 1;
  return {
    decks,
    notes,
    cards: state.cards.size,
    reviews: countReviews(state),
    media: state.media.size,
  };
}

/** Builds the entries of a backup archive; {@link packBackup} zips them. */
export function buildBackup(state: CollectionState, options: BuildBackupOptions): BuiltBackup {
  const dateStamp = new Date(options.nowMs).toISOString().slice(0, 10);
  const entries = exportFlashpkgFiles(state, {
    name: `Flashcards backup ${dateStamp}`,
    version: '1.0.0',
  });
  const serialized = serializeCollectionState(state, options.watermarks ?? {});
  entries[BACKUP_STATE_PATH] = encodeUtf8(JSON.stringify(serialized));

  const mediaEntries: Record<string, Uint8Array> = {};
  const mediaHashes: string[] = [];
  for (const [hash, entry] of state.media) {
    const normHash = hash.toLowerCase();
    mediaHashes.push(normHash);
    if (options.kind !== 'full' || !options.mediaBlobs) continue;
    const ext = entry.ext.toLowerCase().replace(/^\./, '');
    if (!safeMediaMimeForExt(ext)) continue;
    const blob = options.mediaBlobs.get(normHash) ?? options.mediaBlobs.get(hash);
    if (blob) mediaEntries[`media/${normHash}.${ext}`] = blob;
  }
  mediaHashes.sort();

  const manifest: BackupManifest = {
    format_version: BACKUP_FORMAT_VERSION,
    backup_id: options.backupId,
    kind: options.kind,
    reason: options.reason,
    created_at: options.nowMs,
    device_id: options.deviceId,
    ...(options.collectionId !== undefined ? { collection_id: options.collectionId } : {}),
    total_events: getTotalAppliedEventCount(state),
    counts: countBackupContents(state),
    media_hashes: mediaHashes,
    media_included: options.kind === 'full' && Object.keys(mediaEntries).length > 0,
  };
  return { manifest, entries, mediaEntries };
}

/**
 * Zips a built backup. `withMedia: false` writes the same snapshot as a daily one (no media), for
 * example for the copy in the sync folder, whose `media/` store already holds the files.
 */
export function packBackup(
  built: BuiltBackup,
  opts: { withMedia: boolean },
): { manifest: BackupManifest; bytes: Uint8Array } {
  const withMedia = opts.withMedia && built.manifest.media_included;
  const manifest: BackupManifest = withMedia
    ? built.manifest
    : { ...built.manifest, kind: 'daily', media_included: false };
  const files: Record<string, Uint8Array> = { ...built.entries };
  if (withMedia) Object.assign(files, built.mediaEntries);
  files[BACKUP_MANIFEST_PATH] = encodeUtf8(JSON.stringify(manifest, null, 2));
  return { manifest, bytes: zipSync(files, { level: 6 }) };
}

/** A media file packed in a backup archive (hash not verified yet: see {@link verifyBackupMedia}). */
export interface BackupMediaFile {
  hash: string;
  ext: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ReadBackupResult {
  manifest: BackupManifest;
  serialized: SerializedCollectionState;
  state: CollectionState;
  /** Media files by declared hash. */
  media: Map<string, BackupMediaFile>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array | undefined, path: string): unknown {
  if (!bytes) throw new BackupArchiveError(`This file is not a backup: "${path}" is missing.`);
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    throw new BackupArchiveError(`The backup is damaged: "${path}" is not valid JSON.`);
  }
}

function parseManifest(raw: unknown): BackupManifest {
  if (!isRecord(raw)) throw new BackupArchiveError('The backup manifest is damaged.');
  const formatVersion = raw['format_version'];
  if (typeof formatVersion !== 'number' || formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupArchiveError('This backup was made by a newer version of the app. Update it.');
  }
  const counts = isRecord(raw['counts']) ? raw['counts'] : {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const mediaHashes = Array.isArray(raw['media_hashes'])
    ? raw['media_hashes'].filter(
        (h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h),
      )
    : [];
  const kind = raw['kind'] === 'full' ? 'full' : 'daily';
  const reason =
    raw['reason'] === 'manual' || raw['reason'] === 'pre-restore' ? raw['reason'] : 'auto';
  return {
    format_version: formatVersion,
    backup_id: typeof raw['backup_id'] === 'string' ? raw['backup_id'] : 'unknown',
    kind,
    reason,
    created_at: num(raw['created_at']),
    device_id: typeof raw['device_id'] === 'string' ? raw['device_id'] : 'unknown',
    ...(typeof raw['collection_id'] === 'string' ? { collection_id: raw['collection_id'] } : {}),
    total_events: num(raw['total_events']),
    counts: {
      decks: num(counts['decks']),
      notes: num(counts['notes']),
      cards: num(counts['cards']),
      reviews: num(counts['reviews']),
      media: num(counts['media']),
    },
    media_hashes: mediaHashes,
    media_included: raw['media_included'] === true,
  };
}

const STATE_ARRAY_KEYS = [
  'noteTypes',
  'layouts',
  'decks',
  'notes',
  'cards',
  'undoneReviewIds',
  'pages',
  'courses',
  'media',
  'unknownEvents',
] as const;
const STATE_RECORD_KEYS = [
  'watermarks',
  'reviewsByCard',
  'deckFsrsParams',
  'preferences',
  'fieldHlcs',
  'noteArchivedState',
  'pendingDeckPatches',
  'pendingPagePatches',
] as const;

function parseSerializedState(raw: unknown): SerializedCollectionState {
  if (!isRecord(raw) || raw['formatVersion'] !== SERIALIZED_STATE_FORMAT_VERSION) {
    throw new BackupArchiveError('The backup was made by an incompatible version of the app.');
  }
  for (const key of STATE_ARRAY_KEYS) {
    if (!Array.isArray(raw[key])) throw new BackupArchiveError('The backup state is damaged.');
  }
  for (const key of STATE_RECORD_KEYS) {
    if (!isRecord(raw[key])) throw new BackupArchiveError('The backup state is damaged.');
  }
  return raw as unknown as SerializedCollectionState;
}

/**
 * Reads a backup archive (it may be a file the user picked, so it is untrusted: capped unzip,
 * shape checks, and media hashes checked later by {@link verifyBackupMedia}). Throws
 * {@link BackupArchiveError} for a plain `.flashpkg` without `backup/state.json`.
 */
export function readBackupArchive(bytes: Uint8Array): ReadBackupResult {
  const extracted = safeUnzip(
    bytes,
    BACKUP_ARCHIVE_LIMITS,
    {
      security: (message) => new BackupArchiveError(message),
      invalid: (message) => new BackupArchiveError(message),
    },
    'backup',
  );
  const manifest = parseManifest(
    parseJson(extracted.get(BACKUP_MANIFEST_PATH), BACKUP_MANIFEST_PATH),
  );
  const serialized = parseSerializedState(
    parseJson(extracted.get(BACKUP_STATE_PATH), BACKUP_STATE_PATH),
  );
  let state: CollectionState;
  try {
    state = deserializeCollectionState(serialized);
  } catch {
    throw new BackupArchiveError('The backup state is damaged.');
  }
  const media = new Map<string, BackupMediaFile>();
  for (const [path, fileBytes] of extracted) {
    const match = /^media\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/i.exec(path);
    if (!match) continue;
    const hash = (match[1] ?? '').toLowerCase();
    const ext = (match[2] ?? '').toLowerCase();
    const mime = safeMediaMimeForExt(ext);
    if (!mime) continue;
    media.set(hash, { hash, ext, mime, bytes: fileBytes });
  }
  return { manifest, serialized, state, media };
}

/**
 * Adds media files to a backup archive that lacks them (a daily snapshot being saved off the
 * device). `mediaBlobs` maps a content hash to its bytes; hashes without a blob stay out.
 */
export function withBackupMedia(
  archiveBytes: Uint8Array,
  mediaBlobs: ReadonlyMap<string, Uint8Array>,
): { manifest: BackupManifest; bytes: Uint8Array; missingMedia: number } {
  const extracted = safeUnzip(
    archiveBytes,
    BACKUP_ARCHIVE_LIMITS,
    {
      security: (message) => new BackupArchiveError(message),
      invalid: (message) => new BackupArchiveError(message),
    },
    'backup',
  );
  const manifest = parseManifest(
    parseJson(extracted.get(BACKUP_MANIFEST_PATH), BACKUP_MANIFEST_PATH),
  );
  const serialized = parseSerializedState(
    parseJson(extracted.get(BACKUP_STATE_PATH), BACKUP_STATE_PATH),
  );
  const files: Record<string, Uint8Array> = Object.fromEntries(extracted);
  let added = 0;
  let missingMedia = 0;
  for (const entry of serialized.media) {
    const hash = entry.hash.toLowerCase();
    const ext = entry.ext.toLowerCase().replace(/^\./, '');
    if (!safeMediaMimeForExt(ext)) continue;
    const path = `media/${hash}.${ext}`;
    if (files[path]) continue;
    const blob = mediaBlobs.get(hash);
    if (!blob) {
      missingMedia += 1;
      continue;
    }
    files[path] = blob;
    added += 1;
  }
  const next: BackupManifest =
    added > 0 || manifest.media_included ? { ...manifest, media_included: true } : manifest;
  files[BACKUP_MANIFEST_PATH] = encodeUtf8(JSON.stringify(next, null, 2));
  return { manifest: next, bytes: zipSync(files, { level: 6 }), missingMedia };
}

/** True when the file's bytes match its declared content hash. */
export function verifyBackupMedia(file: BackupMediaFile): boolean {
  return sha256Hex(file.bytes) === file.hash;
}
