import type { SerializedCollectionState } from '../events/snapshot.ts';
import type { FlashEvent } from '../events/types.ts';
import { compareHlc } from '../hlc.ts';
import { uuidv7 } from '../ids.ts';
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
  encodeSyncSnapshot,
  manifestPath,
  parseDeviceHeadPath,
  parseSnapshotPath,
  sanitizeDeviceId,
  snapshotPath,
  snapshotsPrefix,
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
  } = options;

  const deviceId = sanitizeDeviceId(options.deviceId);
  const cursor = cloneCursor(options.cursor);

  // -------------------------------------------------------------------------
  // 1. Read or initialize sync/v1/manifest.json + compatibility gate
  // -------------------------------------------------------------------------
  let manifest: SyncManifest;
  try {
    const manifestBytes = await transport.read(manifestPath());
    manifest = decodeManifest(manifestBytes);
  } catch (err) {
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
  cursor.collectionId = manifest.collection_id;

  const compat = checkManifestCompatibility(manifest, maxFormatVersion, appVersion);
  const readOnly = !compat.compatible;

  // -------------------------------------------------------------------------
  // 2. Pull (Snapshot bootstrap for fresh devices + unseen remote segments)
  // -------------------------------------------------------------------------
  let hydratedSnapshot: SyncSnapshot | undefined;
  const pulledEvents: FlashEvent[] = [];
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
        const snap = decodeSyncSnapshot(snapBytes);
        if (
          snap.format_version <= maxFormatVersion &&
          snap.collection_id === manifest.collection_id
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
        if (isNotFound(err)) continue;
        if (readOnly && err instanceof SyncCodecError) continue;
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
  // 3. Push (Write-once segments first, then update head.json)
  // -------------------------------------------------------------------------
  let pushedEventCount = 0;
  let pushedSegmentsCount = 0;

  if (!readOnly) {
    const rawPending = await getLocalEventsAfterSeq(cursor.lastPushedSeq);
    const pendingEvents = rawPending
      .filter((ev) => ev.device === deviceId && ev.seq > cursor.lastPushedSeq)
      .sort((a, b) => a.seq - b.seq);

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

        try {
          await transport.write(targetPath, encodeSyncSnapshot(snapshot), { ifAbsent: true });
          snapshotWritten = targetPath;
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
    ...(hydratedSnapshot !== undefined ? { hydratedSnapshot } : {}),
    ...(snapshotWritten !== undefined ? { snapshotWritten } : {}),
    ...(maxRemoteHlc !== undefined ? { maxRemoteHlc } : {}),
    cursor,
    ...(compat.reason !== undefined ? { message: compat.reason } : {}),
  };
}
