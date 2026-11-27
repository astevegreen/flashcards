import {
  SERIALIZED_STATE_FORMAT_VERSION,
  snapshotLacksMediaRecords,
} from '../events/snapshot-format.ts';
import type { SerializedCollectionState } from '../events/snapshot.ts';
import type { FlashEvent, KnownEvent } from '../events/types.ts';
import { compareHlc } from '../hlc.ts';
import { uuidv7 } from '../ids.ts';
import type { MediaEntry } from '../model/types.ts';
import { sha256Hex } from '../sources/hash.ts';
import {
  checkManifestCompatibility,
  decodeDeviceHead,
  decodeEventsSegment,
  decodeManifest,
  decodeSyncSnapshot,
  deviceHeadPath,
  deviceSegmentPath,
  devicesPrefix,
  encodeDeviceHead,
  encodeEventsSegment,
  encodeManifest,
  encodeReadableSyncSnapshot,
  manifestPath,
  mediaObjectPath,
  parseDeviceHeadPath,
  parseSnapshotPath,
  sanitizeDeviceId,
  snapshotPath,
  snapshotsPrefix,
  SYNC_MEDIA_LIMITS,
  type SYNC_CODEC_LIMITS,
  SyncCodecError,
} from './codec.ts';
import {
  APP_SYNC_VERSION,
  isSyncTransportError,
  SYNC_FORMAT_VERSION,
  SYNC_SNAPSHOT_VERSION,
  type DeviceHead,
  type SegmentRange,
  type SyncCursorState,
  type SyncManifest,
  type SyncMediaStore,
  type SyncRunResult,
  type SyncSnapshot,
  type SyncStoreTransport,
} from './types.ts';

export interface SyncEngineOptions {
  transport: SyncStoreTransport;
  deviceId: string;
  cursor: SyncCursorState;
  /** Highest own sequence number already present in local storage. */
  localOwnSeq: number;
  /** Current total events applied locally (used to trigger periodic snapshots). */
  currentTotalEvents?: number;
  /** True when local device is empty and eligible to hydrate directly from a cloud snapshot. */
  canBootstrapFromSnapshot?: boolean;
  /** Fetch local events authored by `deviceId` with `seq > afterSeq`, sorted ascending by seq. */
  getLocalEventsAfterSeq: (afterSeq: number) => Promise<FlashEvent[]>;
  /**
   * Called after pull & push when the snapshot threshold is crossed.
   * Must return the serialized collection state incorporating `pulledEvents` (and `hydratedSnapshot` if present).
   */
  buildSnapshotState?: (
    pulledEvents: readonly FlashEvent[],
    hydratedSnapshot?: SyncSnapshot,
  ) => Promise<{
    state: SerializedCollectionState;
    totalEvents: number;
    watermarks?: Record<string, number>;
  } | null>;
  /** Current app version for `min_app_version` gate (default `APP_SYNC_VERSION`). */
  appVersion?: string;
  /** Max format version supported by this build (default `SYNC_FORMAT_VERSION`). */
  maxFormatVersion?: number;
  /** Max events packed into a single write-once segment (default `2000`). */
  maxEventsPerSegment?: number;
  /** Write a new snapshot when >= N new events occurred since last snapshot (default `500`). */
  snapshotThreshold?: number;
  /** Injectable clock for deterministic tests. */
  nowMs?: () => number;
  /** Injectable collection ID generator for deterministic tests. */
  generateCollectionId?: () => string;
  /** Optional local media blob store for syncing `media/<aa>/<sha256>.<ext>` (§4.2). */
  mediaStore?: SyncMediaStore;
  /** Known `MediaAdded` entries from current local `CollectionState` (for self-healing push/pull). */
  knownMediaEntries?: readonly MediaEntry[];
  /** Max allowed media blob size in bytes (default `SYNC_MEDIA_LIMITS.maxMediaBlobBytes`). */
  maxMediaBlobBytes?: number;
  /**
   * Size caps for reading and writing snapshots (default `SYNC_CODEC_LIMITS`). Only tests set it,
   * to exercise the over-cap path (D12) without a 25 MiB fixture.
   */
  snapshotLimits?: Partial<typeof SYNC_CODEC_LIMITS>;
  /**
   * The collection an add-device link named. When this device is not bound to a collection yet
   * and the existing remote store holds a different one, the run stops with
   * `collection_choice_required` before binding, pulling or pushing anything.
   */
  expectedCollectionId?: string;
}

const DEFAULT_MAX_EVENTS_PER_SEGMENT = 2000;
const DEFAULT_SNAPSHOT_THRESHOLD = 500;
const MAX_SEGMENT_COLLISION_RETRIES = 16;

function cloneCursor(cursor: SyncCursorState): SyncCursorState {
  return {
    ...(cursor.collectionId !== undefined ? { collectionId: cursor.collectionId } : {}),
    lastPushedSeq: cursor.lastPushedSeq,
    lastPushedSegment: cursor.lastPushedSegment,
    pushedSegments: cursor.pushedSegments.map((s) => ({ ...s })),
    remoteWatermarks: { ...cursor.remoteWatermarks },
    remoteSegments: { ...cursor.remoteSegments },
    lastSnapshotTotalEvents: cursor.lastSnapshotTotalEvents,
    ...(cursor.lastSyncedAt !== undefined ? { lastSyncedAt: cursor.lastSyncedAt } : {}),
    ...(cursor.pushedMediaHashes !== undefined
      ? { pushedMediaHashes: [...cursor.pushedMediaHashes] }
      : {}),
  };
}

function extractMediaEntryFromEvent(ev: FlashEvent): MediaEntry | null {
  if (ev.type !== 'MediaAdded') return null;
  const payload = (ev as KnownEvent & { type: 'MediaAdded' }).payload;
  const m = payload?.media;
  if (!m || typeof m.hash !== 'string' || typeof m.ext !== 'string' || typeof m.mime !== 'string') {
    return null;
  }
  return {
    hash: m.hash.toLowerCase(),
    ext: m.ext.toLowerCase(),
    mime: m.mime,
    size: typeof m.size === 'number' ? m.size : 0,
    ...(typeof m.tts_key === 'string' ? { tts_key: m.tts_key } : {}),
    ...(typeof m.tts_lang_key === 'string' ? { tts_lang_key: m.tts_lang_key } : {}),
  };
}

function isNotFound(err: unknown): boolean {
  if (isSyncTransportError(err)) return err.code === 'NOT_FOUND';
  return err instanceof Error && /not found/i.test(err.message);
}

function isAlreadyExists(err: unknown): boolean {
  if (isSyncTransportError(err)) return err.code === 'ALREADY_EXISTS';
  return err instanceof Error && /already exists/i.test(err.message);
}

function sameSegmentContent(
  existing: readonly FlashEvent[],
  incoming: readonly FlashEvent[],
): boolean {
  if (existing.length !== incoming.length) return false;
  for (let i = 0; i < existing.length; i++) {
    const a = existing[i];
    const b = incoming[i];
    if (!a || !b || a.id !== b.id || a.seq !== b.seq || a.device !== b.device) {
      return false;
    }
  }
  return true;
}

function mergeSegmentRanges(
  existing: readonly SegmentRange[],
  added: readonly SegmentRange[],
): SegmentRange[] {
  const bySeg = new Map<number, SegmentRange>();
  for (const s of existing) bySeg.set(s.seg, { ...s });
  for (const s of added) bySeg.set(s.seg, { ...s });
  return [...bySeg.values()].sort((a, b) => a.seg - b.seg);
}

/**
 * Pure TypeScript `sync/v1` engine implementing blueprint §4.2:
 * 1. Manifest & forward/backward compatibility gate (`format_version` / `min_app_version`)
 * 2. Pull (optional snapshot bootstrap + per-device `head.json` + unseen segments only)
 * 3. Push (write-once `seg-XXXXXX.jsonl.gz` first, then `head.json`)
 * 4. Periodic snapshot compaction
 */
export async function runSync(options: SyncEngineOptions): Promise<SyncRunResult> {
  const {
    transport,
    localOwnSeq,
    getLocalEventsAfterSeq,
    buildSnapshotState,
    canBootstrapFromSnapshot = false,
    appVersion = APP_SYNC_VERSION,
    maxFormatVersion = SYNC_FORMAT_VERSION,
    maxEventsPerSegment = DEFAULT_MAX_EVENTS_PER_SEGMENT,
    snapshotThreshold = DEFAULT_SNAPSHOT_THRESHOLD,
    nowMs = () => Date.now(),
    generateCollectionId = () => `col-${uuidv7(nowMs())}`,
    mediaStore,
    knownMediaEntries,
    maxMediaBlobBytes = SYNC_MEDIA_LIMITS.maxMediaBlobBytes,
    snapshotLimits,
    expectedCollectionId,
  } = options;

  const deviceId = sanitizeDeviceId(options.deviceId);
  const cursor = cloneCursor(options.cursor);

  // -------------------------------------------------------------------------
  // 1. Read or initialize sync/v1/manifest.json + compatibility gate
  // -------------------------------------------------------------------------
  let manifest: SyncManifest;
  let manifestExisted = true;
  try {
    const manifestBytes = await transport.read(manifestPath());
    manifest = decodeManifest(manifestBytes);
  } catch (err) {
    manifestExisted = false;
    if (!isNotFound(err)) {
      throw err;
    }
    const created: SyncManifest = {
      collection_id: cursor.collectionId ?? generateCollectionId(),
      format_version: maxFormatVersion,
      min_app_version: appVersion,
      created_at: nowMs(),
    };
    try {
      await transport.write(manifestPath(), encodeManifest(created), { ifAbsent: true });
      manifest = created;
    } catch (writeErr) {
      if (!isAlreadyExists(writeErr)) {
        throw writeErr;
      }
      // Another device initialized the manifest concurrently; adopt it.
      const racedBytes = await transport.read(manifestPath());
      manifest = decodeManifest(racedBytes);
    }
  }

  if (cursor.collectionId !== undefined && cursor.collectionId !== manifest.collection_id) {
    return {
      status: 'collection_mismatch',
      readOnly: true,
      collectionId: manifest.collection_id,
      manifest,
      pulledEvents: [],
      pushedEventCount: 0,
      pushedSegments: 0,
      cursor,
      message: `Remote sync store belongs to collection "${manifest.collection_id}" but this device is bound to "${cursor.collectionId}".`,
    };
  }
  if (
    manifestExisted &&
    cursor.collectionId === undefined &&
    expectedCollectionId !== undefined &&
    expectedCollectionId !== manifest.collection_id
  ) {
    // This device has not joined any collection yet and the store it reached is not the one it
    // was told to expect. Nothing is pulled, pushed or bound: the caller asks the user first.
    return {
      status: 'collection_choice_required',
      readOnly: true,
      collectionId: manifest.collection_id,
      manifest,
      pulledEvents: [],
      pushedEventCount: 0,
      pushedSegments: 0,
      cursor,
      message: `Remote sync store belongs to collection "${manifest.collection_id}" but this device expected "${expectedCollectionId}".`,
    };
  }
  cursor.collectionId = manifest.collection_id;

  const compat = checkManifestCompatibility(manifest, maxFormatVersion, appVersion);
  const readOnly = !compat.compatible;

  // -------------------------------------------------------------------------
  // 2. Pull (Snapshot bootstrap for fresh devices + unseen remote segments)
  // -------------------------------------------------------------------------
  let hydratedSnapshot: SyncSnapshot | undefined;
  const pulledEvents: FlashEvent[] = [];
  const pullWarnings: string[] = [];
  let maxRemoteHlc: string | undefined;

  if (
    canBootstrapFromSnapshot &&
    localOwnSeq === 0 &&
    Object.keys(cursor.remoteWatermarks).length === 0
  ) {
    const snapFiles = await transport.list(snapshotsPrefix());
    const candidates = snapFiles
      .map((f) => ({ file: f, parsed: parseSnapshotPath(f.path) }))
      .filter(
        (x): x is { file: (typeof snapFiles)[number]; parsed: { deviceId: string; seq: number } } =>
          x.parsed !== null,
      )
      .sort((a, b) => {
        const tDiff = (b.file.updatedAt ?? 0) - (a.file.updatedAt ?? 0);
        if (tDiff !== 0) return tDiff;
        if (b.parsed.seq !== a.parsed.seq) return b.parsed.seq - a.parsed.seq;
        return b.file.path < a.file.path ? -1 : b.file.path > a.file.path ? 1 : 0;
      });

    for (const candidate of candidates) {
      try {
        const snapBytes = await transport.read(candidate.file.path);
        const snap = decodeSyncSnapshot(snapBytes, snapshotLimits);
        if (
          snap.format_version <= maxFormatVersion &&
          // A newer state format would be hydrated lossily while the watermarks suppress the
          // events its unknown fields came from (D13); replay the segments instead.
          (typeof snap.state.formatVersion !== 'number' ||
            snap.state.formatVersion <= SERIALIZED_STATE_FORMAT_VERSION) &&
          snap.collection_id === manifest.collection_id &&
          // From a build before media removal: replaying the segments agrees with other devices.
          !snapshotLacksMediaRecords(snap.state)
        ) {
          hydratedSnapshot = snap;
          for (const [dev, seq] of Object.entries(snap.watermarks)) {
            if (typeof seq === 'number' && seq > 0) {
              cursor.remoteWatermarks[dev] = Math.max(cursor.remoteWatermarks[dev] ?? 0, seq);
            }
          }
          cursor.lastSnapshotTotalEvents = Math.max(
            cursor.lastSnapshotTotalEvents,
            snap.total_events,
          );
          break;
        }
      } catch (err) {
        // Skip incompatible/unreadable snapshots gracefully
        if (!isNotFound(err) && !(err instanceof SyncCodecError)) {
          throw err;
        }
      }
    }
  }

  const deviceFiles = await transport.list(devicesPrefix());
  const remoteDeviceIds: string[] = [];
  for (const f of deviceFiles) {
    const devId = parseDeviceHeadPath(f.path);
    if (devId && !remoteDeviceIds.includes(devId)) {
      remoteDeviceIds.push(devId);
    }
  }
  remoteDeviceIds.sort();

  for (const devId of remoteDeviceIds) {
    let head: DeviceHead;
    try {
      const headBytes = await transport.read(deviceHeadPath(devId));
      head = decodeDeviceHead(headBytes);
    } catch (err) {
      if (isNotFound(err)) continue;
      if (readOnly && err instanceof SyncCodecError) continue;
      throw err;
    }

    if (devId === deviceId) {
      // Track our highest remote segment number so crash recovery never collides
      if (head.last_segment > cursor.lastPushedSegment) {
        cursor.lastPushedSegment = head.last_segment;
      }
      if (head.segments && head.segments.length > 0 && cursor.pushedSegments.length === 0) {
        cursor.pushedSegments = mergeSegmentRanges(cursor.pushedSegments, head.segments);
      }
      const ownSeen = Math.max(
        localOwnSeq,
        cursor.remoteWatermarks[devId] ?? 0,
        cursor.lastPushedSeq,
      );
      if (head.last_seq <= ownSeen) {
        // Ignore own already-applied seqs and mark them as already pushed so
        // reconnecting to the same sync store never duplicates write-once segments.
        cursor.remoteWatermarks[devId] = Math.max(cursor.remoteWatermarks[devId] ?? 0, ownSeen);
        cursor.lastPushedSeq = Math.max(cursor.lastPushedSeq, head.last_seq);
        continue;
      }
    }

    const seenSeq =
      devId === deviceId
        ? Math.max(localOwnSeq, cursor.remoteWatermarks[devId] ?? 0, cursor.lastPushedSeq)
        : (cursor.remoteWatermarks[devId] ?? 0);

    if (head.last_seq <= seenSeq) {
      continue;
    }

    let segmentNumbersToFetch: number[];
    if (head.segments && head.segments.length > 0) {
      segmentNumbersToFetch = [...head.segments]
        .filter((s) => s.to_seq > seenSeq)
        .sort((a, b) => a.seg - b.seg)
        .map((s) => s.seg);
    } else {
      const startSeg = (cursor.remoteSegments[devId] ?? 0) + 1;
      segmentNumbersToFetch = [];
      for (let seg = startSeg; seg <= head.last_segment; seg++) {
        segmentNumbersToFetch.push(seg);
      }
    }

    let maxPulledSeq = seenSeq;
    for (const segNum of segmentNumbersToFetch) {
      let segEvents: FlashEvent[];
      try {
        const segBytes = await transport.read(deviceSegmentPath(devId, segNum));
        segEvents = decodeEventsSegment(segBytes);
      } catch (err) {
        // A listed segment that can't be read (listing lag, a deleted file, a corrupt or newer
        // format) ends this device's pull here; other devices still sync. Skipping it would let
        // later segments move the watermark past its events, and they would never be fetched again
        // (nor by any device hydrating from a snapshot that carries that watermark). The next sync
        // retries from it.
        if (isNotFound(err) || err instanceof SyncCodecError) {
          pullWarnings.push(
            `Segment ${segNum} from device ${devId} could not be read; its events and any later ones will be retried on the next sync.`,
          );
          break;
        }
        throw err;
      }

      for (const ev of segEvents) {
        if (ev.seq <= seenSeq) continue;
        pulledEvents.push(ev);
        if (ev.seq > maxPulledSeq) {
          maxPulledSeq = ev.seq;
        }
        if (maxRemoteHlc === undefined || compareHlc(ev.hlc, maxRemoteHlc) > 0) {
          maxRemoteHlc = ev.hlc;
        }
      }
      cursor.remoteSegments[devId] = Math.max(cursor.remoteSegments[devId] ?? 0, segNum);
    }

    cursor.remoteWatermarks[devId] = Math.max(seenSeq, maxPulledSeq);
    if (devId === deviceId) {
      cursor.lastPushedSeq = Math.max(cursor.lastPushedSeq, maxPulledSeq);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Push (Media blobs first for atomic visibility, then write-once segments, then head.json)
  // -------------------------------------------------------------------------
  let pushedEventCount = 0;
  let pushedSegmentsCount = 0;
  let pushedMediaCount = 0;
  let pulledMediaCount = 0;
  const mediaWarnings: string[] = [];
  const pushedMediaSet = new Set<string>(cursor.pushedMediaHashes ?? []);

  if (!readOnly) {
    const rawPending = await getLocalEventsAfterSeq(cursor.lastPushedSeq);
    const pendingEvents = rawPending
      .filter((ev) => ev.device === deviceId && ev.seq > cursor.lastPushedSeq)
      .sort((a, b) => a.seq - b.seq);

    // 3a. Push missing local media blobs BEFORE writing segments/head.json
    if (mediaStore) {
      const mediaToPush = new Map<string, { entry: MediaEntry; fromPending: boolean }>();
      for (const ev of pendingEvents) {
        const entry = extractMediaEntryFromEvent(ev);
        if (entry) {
          mediaToPush.set(entry.hash, { entry, fromPending: true });
        }
      }
      if (knownMediaEntries) {
        for (const entry of knownMediaEntries) {
          const normHash = entry.hash.toLowerCase();
          if (!pushedMediaSet.has(normHash) && !mediaToPush.has(normHash)) {
            mediaToPush.set(normHash, {
              entry: { ...entry, hash: normHash, ext: entry.ext.toLowerCase() },
              fromPending: false,
            });
          }
        }
      }

      for (const { entry, fromPending } of mediaToPush.values()) {
        if (pushedMediaSet.has(entry.hash)) continue;
        let path: string;
        try {
          path = mediaObjectPath(entry.hash, entry.ext);
        } catch (err) {
          mediaWarnings.push(
            `Skipped unsafe media entry "${entry.hash}": ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        const localBlob = await mediaStore.getLocalMedia(entry.hash);
        if (!localBlob) {
          if (fromPending) {
            mediaWarnings.push(`Local media blob missing for ${entry.hash.slice(0, 12)}…`);
          }
          continue;
        }
        if (localBlob.bytes.byteLength > maxMediaBlobBytes) {
          mediaWarnings.push(
            `Local media blob ${entry.hash.slice(0, 12)}… exceeds max size (${maxMediaBlobBytes} bytes).`,
          );
          continue;
        }
        const actualHash = sha256Hex(localBlob.bytes);
        if (actualHash !== entry.hash) {
          mediaWarnings.push(
            `Local media hash mismatch for ${entry.hash.slice(0, 12)}… (got ${actualHash.slice(0, 12)}…).`,
          );
          continue;
        }
        try {
          await transport.write(path, localBlob.bytes, { ifAbsent: true });
          pushedMediaCount += 1;
          pushedMediaSet.add(entry.hash);
        } catch (err) {
          if (isAlreadyExists(err)) {
            pushedMediaSet.add(entry.hash);
          } else {
            throw err;
          }
        }
      }

      if (pushedMediaSet.size > 0) {
        cursor.pushedMediaHashes = [...pushedMediaSet].sort();
      }
    }

    if (pendingEvents.length > 0) {
      let nextSeg = cursor.lastPushedSegment;
      const newRanges: SegmentRange[] = [];

      for (let offset = 0; offset < pendingEvents.length; offset += maxEventsPerSegment) {
        const chunk = pendingEvents.slice(offset, offset + maxEventsPerSegment);
        const firstEv = chunk[0];
        const lastEv = chunk[chunk.length - 1];
        if (!firstEv || !lastEv) continue;

        const segBytes = encodeEventsSegment(chunk);
        let writtenSegNum = 0;

        for (let attempt = 0; attempt < MAX_SEGMENT_COLLISION_RETRIES; attempt++) {
          nextSeg += 1;
          const segPath = deviceSegmentPath(deviceId, nextSeg);
          try {
            await transport.write(segPath, segBytes, { ifAbsent: true });
            writtenSegNum = nextSeg;
            pushedSegmentsCount += 1;
            break;
          } catch (err) {
            if (!isAlreadyExists(err)) {
              throw err;
            }
            // Crash recovery: if a previous run already uploaded this exact segment before updating head.json, adopt it.
            try {
              const existingBytes = await transport.read(segPath);
              const existingEvents = decodeEventsSegment(existingBytes);
              if (sameSegmentContent(existingEvents, chunk)) {
                writtenSegNum = nextSeg;
                break;
              }
            } catch {
              // Fall through and advance to next segment number without overwriting
            }
          }
        }

        if (writtenSegNum === 0) {
          throw new Error(`Failed to allocate write-once segment for device "${deviceId}".`);
        }

        newRanges.push({
          seg: writtenSegNum,
          from_seq: firstEv.seq,
          to_seq: lastEv.seq,
          count: chunk.length,
        });
        pushedEventCount += chunk.length;
      }

      const lastPushed = pendingEvents[pendingEvents.length - 1];
      if (lastPushed) {
        const mergedSegments = mergeSegmentRanges(cursor.pushedSegments, newRanges);
        const head: DeviceHead = {
          device_id: deviceId,
          last_segment: nextSeg,
          last_seq: lastPushed.seq,
          updated_at: nowMs(),
          segments: mergedSegments,
        };
        // Only write head.json AFTER all segments have been durably written
        await transport.write(deviceHeadPath(deviceId), encodeDeviceHead(head), {
          ifAbsent: false,
        });

        cursor.lastPushedSegment = nextSeg;
        cursor.lastPushedSeq = lastPushed.seq;
        cursor.pushedSegments = mergedSegments;
        cursor.remoteWatermarks[deviceId] = Math.max(
          cursor.remoteWatermarks[deviceId] ?? 0,
          lastPushed.seq,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3b. Pull missing remote media blobs referenced by snapshot / pulled / known MediaAdded
  // -------------------------------------------------------------------------
  if (mediaStore) {
    const mediaToPull = new Map<string, MediaEntry>();
    if (hydratedSnapshot?.state.media) {
      for (const m of hydratedSnapshot.state.media) {
        mediaToPull.set(m.hash.toLowerCase(), {
          ...m,
          hash: m.hash.toLowerCase(),
          ext: m.ext.toLowerCase(),
        });
      }
    }
    for (const ev of pulledEvents) {
      const entry = extractMediaEntryFromEvent(ev);
      if (entry) {
        mediaToPull.set(entry.hash, entry);
      }
    }
    if (knownMediaEntries) {
      for (const m of knownMediaEntries) {
        const normHash = m.hash.toLowerCase();
        if (!mediaToPull.has(normHash)) {
          mediaToPull.set(normHash, { ...m, hash: normHash, ext: m.ext.toLowerCase() });
        }
      }
    }

    for (const entry of mediaToPull.values()) {
      const existingLocal = await mediaStore.getLocalMedia(entry.hash);
      if (existingLocal) {
        continue;
      }
      let path: string;
      try {
        path = mediaObjectPath(entry.hash, entry.ext);
      } catch (err) {
        mediaWarnings.push(
          `Skipped unsafe remote media entry "${entry.hash}": ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      let remoteBytes: Uint8Array;
      try {
        remoteBytes = await transport.read(path);
      } catch (err) {
        if (isNotFound(err)) {
          mediaWarnings.push(`Remote media blob not found at "${path}".`);
          continue;
        }
        // A transport that stopped reading a blob past its size cap: the same outcome as the
        // size check below, without buffering the whole body.
        if (err instanceof SyncCodecError) {
          mediaWarnings.push(`Rejected remote media "${path}": ${err.message}`);
          continue;
        }
        throw err;
      }

      if (remoteBytes.byteLength > maxMediaBlobBytes) {
        mediaWarnings.push(
          `Rejected remote media "${path}": exceeds max size (${remoteBytes.byteLength} > ${maxMediaBlobBytes} bytes).`,
        );
        continue;
      }

      const actualHash = sha256Hex(remoteBytes);
      if (actualHash !== entry.hash) {
        mediaWarnings.push(
          `Rejected tampered remote media "${path}": SHA-256 mismatch (expected ${entry.hash}, got ${actualHash}).`,
        );
        continue;
      }

      await mediaStore.putLocalMedia({
        hash: entry.hash,
        mime: entry.mime,
        bytes: remoteBytes,
      });
      pulledMediaCount += 1;
    }
  }

  // -------------------------------------------------------------------------
  // 4. Periodic Snapshot Compaction
  // -------------------------------------------------------------------------
  let snapshotWritten: string | undefined;

  if (!readOnly && buildSnapshotState) {
    const estimatedTotal =
      hydratedSnapshot !== undefined
        ? hydratedSnapshot.total_events + pulledEvents.length
        : (options.currentTotalEvents ?? 0) + pulledEvents.length;

    if (estimatedTotal - cursor.lastSnapshotTotalEvents >= snapshotThreshold) {
      const built = await buildSnapshotState(pulledEvents, hydratedSnapshot);
      if (built && built.totalEvents - cursor.lastSnapshotTotalEvents >= snapshotThreshold) {
        const watermarks: Record<string, number> = { ...cursor.remoteWatermarks };
        const ownWatermark = Math.max(localOwnSeq, cursor.lastPushedSeq);
        if (ownWatermark > 0) {
          watermarks[deviceId] = Math.max(watermarks[deviceId] ?? 0, ownWatermark);
        }
        if (built.watermarks) {
          for (const [dev, seq] of Object.entries(built.watermarks)) {
            if (seq > 0) {
              watermarks[dev] = Math.max(watermarks[dev] ?? 0, seq);
            }
          }
        }

        const snapSeq = Math.max(ownWatermark, built.totalEvents);
        const targetPath = snapshotPath(deviceId, snapSeq);
        const snapshot: SyncSnapshot = {
          format_version: maxFormatVersion,
          snapshot_version: SYNC_SNAPSHOT_VERSION,
          collection_id: manifest.collection_id,
          created_by: deviceId,
          created_at: nowMs(),
          total_events: built.totalEvents,
          watermarks,
          state: {
            ...built.state,
            watermarks,
            totalEvents: built.totalEvents,
          },
        };

        // A snapshot too big to read back is not uploaded; the next try is `snapshotThreshold`
        // events later (D12).
        const encoded = encodeReadableSyncSnapshot(snapshot, snapshotLimits);
        try {
          if (encoded) {
            await transport.write(targetPath, encoded, { ifAbsent: true });
            snapshotWritten = targetPath;
          }
        } catch (err) {
          if (!isAlreadyExists(err)) {
            throw err;
          }
        }
        cursor.lastSnapshotTotalEvents = built.totalEvents;
      }
    }
  }

  cursor.lastSyncedAt = nowMs();

  return {
    status: readOnly ? 'upgrade_required' : 'ok',
    readOnly,
    collectionId: manifest.collection_id,
    manifest,
    pulledEvents,
    pushedEventCount,
    pushedSegments: pushedSegmentsCount,
    ...(mediaStore ? { pushedMediaCount, pulledMediaCount } : {}),
    ...(mediaWarnings.length > 0 ? { mediaWarnings } : {}),
    ...(pullWarnings.length > 0 ? { pullWarnings } : {}),
    ...(hydratedSnapshot !== undefined ? { hydratedSnapshot } : {}),
    ...(snapshotWritten !== undefined ? { snapshotWritten } : {}),
    ...(maxRemoteHlc !== undefined ? { maxRemoteHlc } : {}),
    cursor,
    ...(compat.reason !== undefined ? { message: compat.reason } : {}),
  };
}
