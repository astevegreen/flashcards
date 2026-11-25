import type { SerializedCollectionState } from '../events/snapshot.ts';
import type { FlashEvent } from '../events/types.ts';

export const SYNC_V1_PREFIX = 'sync/v1';
export const SYNC_FORMAT_VERSION = 1;
export const SYNC_SNAPSHOT_VERSION = 1;
export const APP_SYNC_VERSION = '0.2.0';

export type SyncTransportErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'UNKNOWN';

export class SyncTransportError extends Error {
  readonly code: SyncTransportErrorCode;
  readonly status?: number;

  constructor(code: SyncTransportErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SyncTransportError';
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

export function isSyncTransportError(err: unknown): err is SyncTransportError {
  return (
    err instanceof SyncTransportError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'SyncTransportError' &&
      typeof (err as { code?: unknown }).code === 'string')
  );
}

export interface SyncFileInfo {
  path: string;
  size: number;
  updatedAt?: number;
}

/**
 * Structural transport interface matching `@flash/platform`'s `SyncTransport`
 * without introducing any circular package dependency.
 */
export interface SyncStoreTransport {
  list(prefix: string): Promise<SyncFileInfo[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void>;
}

/** `sync/v1/manifest.json` per blueprint §4.2 */
export interface SyncManifest {
  collection_id: string;
  format_version: number;
  min_app_version: string;
  created_at: number;
  updated_at?: number;
}

export interface SegmentRange {
  seg: number;
  from_seq: number;
  to_seq: number;
  count: number;
}

/** `sync/v1/devices/<device-id>/head.json` per blueprint §4.2 */
export interface DeviceHead {
  device_id: string;
  last_segment: number;
  last_seq: number;
  updated_at: number;
  segments?: SegmentRange[];
}

/** `sync/v1/snapshots/<device-id>-<seq>.json.gz` per blueprint §4.2 */
export interface SyncSnapshot {
  format_version: number;
  snapshot_version: number;
  collection_id: string;
  created_by: string;
  created_at: number;
  total_events: number;
  watermarks: Record<string, number>;
  state: SerializedCollectionState;
}

/** Structural local media store passed to `SyncEngine` for `media/<aa>/<sha256>.<ext>` sync (§4.2). */
export interface SyncMediaStore {
  getLocalMedia(
    hash: string,
  ): Promise<{ hash: string; mime: string; bytes: Uint8Array } | undefined>;
  putLocalMedia(media: { hash: string; mime: string; bytes: Uint8Array }): Promise<void>;
}

/** Per-device persisted sync watermark cursor. */
export interface SyncCursorState {
  collectionId?: string;
  lastPushedSeq: number;
  lastPushedSegment: number;
  pushedSegments: SegmentRange[];
  remoteWatermarks: Record<string, number>;
  remoteSegments: Record<string, number>;
  lastSnapshotTotalEvents: number;
  lastSyncedAt?: number;
  /** Content hashes confirmed uploaded to remote `media/<aa>/<sha256>.<ext>` store. */
  pushedMediaHashes?: string[];
}

export function createInitialSyncCursor(collectionId?: string): SyncCursorState {
  return {
    ...(collectionId !== undefined ? { collectionId } : {}),
    lastPushedSeq: 0,
    lastPushedSegment: 0,
    pushedSegments: [],
    remoteWatermarks: {},
    remoteSegments: {},
    lastSnapshotTotalEvents: 0,
  };
}

export type SyncRunStatus =
  'ok' | 'upgrade_required' | 'collection_mismatch' | 'collection_choice_required';

export interface SyncRunResult {
  status: SyncRunStatus;
  readOnly: boolean;
  collectionId?: string;
  manifest?: SyncManifest;
  pulledEvents: FlashEvent[];
  pushedEventCount: number;
  pushedSegments: number;
  pushedMediaCount?: number;
  pulledMediaCount?: number;
  mediaWarnings?: string[];
  /** Listed segments that could not be read; the pull stopped there and retries next run. */
  pullWarnings?: string[];
  hydratedSnapshot?: SyncSnapshot;
  snapshotWritten?: string;
  maxRemoteHlc?: string;
  cursor: SyncCursorState;
  message?: string;
}
