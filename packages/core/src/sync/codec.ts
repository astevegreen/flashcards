import { Gunzip, gzipSync } from 'fflate';
import type { FlashEvent } from '../events/types.ts';
import { decodeUtf8, encodeUtf8 } from '../ids.ts';
import {
  APP_SYNC_VERSION,
  SYNC_FORMAT_VERSION,
  SYNC_V1_PREFIX,
  type DeviceHead,
  type SegmentRange,
  type SyncManifest,
  type SyncSnapshot,
} from './types.ts';

export const SYNC_CODEC_LIMITS = {
  maxCompressedBytes: 10 * 1024 * 1024, // 10 MiB
  maxUncompressedBytes: 25 * 1024 * 1024, // 25 MiB
} as const;

export class SyncCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncCodecError';
  }
}

const DEVICE_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

export function sanitizeDeviceId(deviceId: string): string {
  if (
    !deviceId ||
    deviceId === '.' ||
    deviceId === '..' ||
    deviceId.includes('/') ||
    deviceId.includes('\\') ||
    deviceId.includes('\0') ||
    !DEVICE_ID_REGEX.test(deviceId)
  ) {
    throw new SyncCodecError(`Invalid device ID for sync path: "${deviceId}"`);
  }
  return deviceId;
}

export function manifestPath(): string {
  return `${SYNC_V1_PREFIX}/manifest.json`;
}

export function devicesPrefix(): string {
  return `${SYNC_V1_PREFIX}/devices/`;
}

export function deviceHeadPath(deviceId: string): string {
  const safeId = sanitizeDeviceId(deviceId);
  return `${SYNC_V1_PREFIX}/devices/${safeId}/head.json`;
}

export function deviceSegmentPath(deviceId: string, segmentNumber: number): string {
  const safeId = sanitizeDeviceId(deviceId);
  if (!Number.isInteger(segmentNumber) || segmentNumber < 1) {
    throw new SyncCodecError(`Invalid segment number: ${segmentNumber}`);
  }
  const padded = String(segmentNumber).padStart(6, '0');
  return `${SYNC_V1_PREFIX}/devices/${safeId}/seg-${padded}.jsonl.gz`;
}

export function snapshotsPrefix(): string {
  return `${SYNC_V1_PREFIX}/snapshots/`;
}

export function snapshotPath(deviceId: string, seq: number): string {
  const safeId = sanitizeDeviceId(deviceId);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new SyncCodecError(`Invalid snapshot sequence number: ${seq}`);
  }
  return `${SYNC_V1_PREFIX}/snapshots/${safeId}-${seq}.json.gz`;
}

export function parseDeviceHeadPath(path: string): string | null {
  const prefix = devicesPrefix();
  const suffix = '/head.json';
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  const rawId = path.slice(prefix.length, path.length - suffix.length);
  if (
    !rawId ||
    rawId.includes('/') ||
    !DEVICE_ID_REGEX.test(rawId) ||
    rawId === '.' ||
    rawId === '..'
  ) {
    return null;
  }
  return rawId;
}

export function parseSegmentNumber(path: string): number | null {
  const match = /\/seg-(\d{6,})\.jsonl\.gz$/.exec(path);
  if (!match || !match[1]) return null;
  const num = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(num) && num >= 1 ? num : null;
}

export function parseSnapshotPath(path: string): { deviceId: string; seq: number } | null {
  const prefix = snapshotsPrefix();
  const suffix = '.json.gz';
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  const stem = path.slice(prefix.length, path.length - suffix.length);
  if (stem.includes('/')) return null;
  const lastDash = stem.lastIndexOf('-');
  if (lastDash <= 0) return null;
  const deviceId = stem.slice(0, lastDash);
  const seqStr = stem.slice(lastDash + 1);
  if (
    !/^\d+$/.test(seqStr) ||
    !DEVICE_ID_REGEX.test(deviceId) ||
    deviceId === '.' ||
    deviceId === '..'
  ) {
    return null;
  }
  const seq = Number.parseInt(seqStr, 10);
  if (!Number.isSafeInteger(seq)) return null;
  return { deviceId, seq };
}

function concatChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Streaming gzip decompression with strict compressed & uncompressed byte caps (§13)
 * so gzip bombs abort immediately before exhausting memory.
 */
export function safeGunzip(
  compressed: Uint8Array,
  limits?: Partial<typeof SYNC_CODEC_LIMITS>,
): Uint8Array {
  const maxCompressed = limits?.maxCompressedBytes ?? SYNC_CODEC_LIMITS.maxCompressedBytes;
  const maxUncompressed = limits?.maxUncompressedBytes ?? SYNC_CODEC_LIMITS.maxUncompressedBytes;

  if (compressed.byteLength === 0) {
    throw new SyncCodecError('Empty gzip payload.');
  }
  if (compressed.byteLength > maxCompressed) {
    throw new SyncCodecError(
      `Compressed sync payload exceeds limit (${compressed.byteLength} > ${maxCompressed} bytes).`,
    );
  }

  const chunks: Uint8Array[] = [];
  let totalUncompressed = 0;
  let streamError: Error | null = null;

  const gunzip = new Gunzip((chunk) => {
    if (streamError) return;
    if (chunk.byteLength > 0) {
      totalUncompressed += chunk.byteLength;
      if (totalUncompressed > maxUncompressed) {
        streamError = new SyncCodecError(
          `Decompressed sync payload exceeds limit (${maxUncompressed} bytes).`,
        );
        return;
      }
      chunks.push(chunk);
    }
  });

  const CHUNK_SIZE = 4096;
  try {
    for (let offset = 0; offset < compressed.byteLength; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, compressed.byteLength);
      const isFinal = end >= compressed.byteLength;
      gunzip.push(compressed.subarray(offset, end), isFinal);
      if (streamError) {
        throw streamError;
      }
    }
  } catch (err) {
    if (streamError) throw streamError;
    if (err instanceof SyncCodecError) throw err;
    throw new SyncCodecError(
      `Failed to decompress gzip sync payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return concatChunks(chunks, totalUncompressed);
}

/** Encodes events as gzipped JSONL preserving all properties verbatim. */
export function encodeEventsSegment(events: readonly FlashEvent[]): Uint8Array {
  const jsonl = events.map((ev) => JSON.stringify(ev)).join('\n') + (events.length > 0 ? '\n' : '');
  return gzipSync(encodeUtf8(jsonl), { level: 6 });
}

/** Decodes a gzipped JSONL segment, preserving unknown event types and extra fields verbatim. */
export function decodeEventsSegment(
  compressed: Uint8Array,
  limits?: Partial<typeof SYNC_CODEC_LIMITS>,
): FlashEvent[] {
  const rawBytes = safeGunzip(compressed, limits);
  const text = decodeUtf8(rawBytes);
  const lines = text.split(/\r?\n/);
  const events: FlashEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new SyncCodecError(
        `Invalid JSON on segment line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SyncCodecError(`Invalid event object on segment line ${i + 1}.`);
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj['id'] !== 'string' ||
      typeof obj['device'] !== 'string' ||
      typeof obj['seq'] !== 'number' ||
      !Number.isFinite(obj['seq']) ||
      typeof obj['hlc'] !== 'string' ||
      typeof obj['type'] !== 'string' ||
      typeof obj['v'] !== 'number'
    ) {
      throw new SyncCodecError(`Malformed event envelope on segment line ${i + 1}.`);
    }
    // Preserve entire object verbatim including any unknown future fields
    events.push(parsed as FlashEvent);
  }

  return events;
}

export function encodeManifest(manifest: SyncManifest): Uint8Array {
  return encodeUtf8(JSON.stringify(manifest, null, 2));
}

export function decodeManifest(bytes: Uint8Array): SyncManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch (err) {
    throw new SyncCodecError(
      `Invalid sync manifest JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyncCodecError('Invalid sync manifest object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj['collection_id'] !== 'string' ||
    !obj['collection_id'] ||
    typeof obj['format_version'] !== 'number' ||
    typeof obj['min_app_version'] !== 'string' ||
    typeof obj['created_at'] !== 'number'
  ) {
    throw new SyncCodecError('Missing required fields in sync manifest.');
  }
  return {
    collection_id: obj['collection_id'],
    format_version: obj['format_version'],
    min_app_version: obj['min_app_version'],
    created_at: obj['created_at'],
    ...(typeof obj['updated_at'] === 'number' ? { updated_at: obj['updated_at'] } : {}),
  };
}

export function encodeDeviceHead(head: DeviceHead): Uint8Array {
  return encodeUtf8(JSON.stringify(head));
}

export function decodeDeviceHead(bytes: Uint8Array): DeviceHead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch (err) {
    throw new SyncCodecError(
      `Invalid device head JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyncCodecError('Invalid device head object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj['device_id'] !== 'string' ||
    typeof obj['last_segment'] !== 'number' ||
    typeof obj['last_seq'] !== 'number' ||
    typeof obj['updated_at'] !== 'number'
  ) {
    throw new SyncCodecError('Missing required fields in device head.');
  }
  let segments: SegmentRange[] | undefined;
  if (Array.isArray(obj['segments'])) {
    segments = [];
    for (const rawSeg of obj['segments']) {
      if (rawSeg && typeof rawSeg === 'object' && !Array.isArray(rawSeg)) {
        const s = rawSeg as Record<string, unknown>;
        if (
          typeof s['seg'] === 'number' &&
          typeof s['from_seq'] === 'number' &&
          typeof s['to_seq'] === 'number' &&
          typeof s['count'] === 'number'
        ) {
          segments.push({
            seg: s['seg'],
            from_seq: s['from_seq'],
            to_seq: s['to_seq'],
            count: s['count'],
          });
        }
      }
    }
  }
  return {
    device_id: obj['device_id'],
    last_segment: obj['last_segment'],
    last_seq: obj['last_seq'],
    updated_at: obj['updated_at'],
    ...(segments !== undefined ? { segments } : {}),
  };
}

export function encodeSyncSnapshot(snapshot: SyncSnapshot): Uint8Array {
  return gzipSync(encodeUtf8(JSON.stringify(snapshot)), { level: 6 });
}

export function decodeSyncSnapshot(
  compressed: Uint8Array,
  limits?: Partial<typeof SYNC_CODEC_LIMITS>,
): SyncSnapshot {
  const rawBytes = safeGunzip(compressed, limits);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(rawBytes));
  } catch (err) {
    throw new SyncCodecError(
      `Invalid sync snapshot JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyncCodecError('Invalid sync snapshot object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj['format_version'] !== 'number' ||
    typeof obj['snapshot_version'] !== 'number' ||
    typeof obj['collection_id'] !== 'string' ||
    typeof obj['created_by'] !== 'string' ||
    typeof obj['created_at'] !== 'number' ||
    typeof obj['total_events'] !== 'number' ||
    !obj['watermarks'] ||
    typeof obj['watermarks'] !== 'object' ||
    !obj['state'] ||
    typeof obj['state'] !== 'object'
  ) {
    throw new SyncCodecError('Missing required fields in sync snapshot.');
  }
  return parsed as SyncSnapshot;
}

/** Pure semver comparison (major.minor.patch). Returns -1, 0, or 1. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const core = v.trim().replace(/^v/i, '').split('-')[0]?.split('+')[0] ?? '0.0.0';
    const parts = core.split('.');
    return [
      Number.parseInt(parts[0] ?? '0', 10) || 0,
      Number.parseInt(parts[1] ?? '0', 10) || 0,
      Number.parseInt(parts[2] ?? '0', 10) || 0,
    ];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}

export interface ManifestCompatibilityResult {
  compatible: boolean;
  reason?: string;
}

/**
 * Forward/backward compatibility gate per blueprint §4.2.
 * Older app builds refuse to write to a newer `format_version` or `min_app_version`.
 */
export function checkManifestCompatibility(
  manifest: SyncManifest,
  maxFormatVersion: number = SYNC_FORMAT_VERSION,
  appVersion: string = APP_SYNC_VERSION,
): ManifestCompatibilityResult {
  if (manifest.format_version > maxFormatVersion) {
    return {
      compatible: false,
      reason: `Sync store format v${manifest.format_version} is newer than this app supports (v${maxFormatVersion}). Update the app to resume syncing writes.`,
    };
  }
  if (compareSemver(manifest.min_app_version, appVersion) > 0) {
    return {
      compatible: false,
      reason: `Sync store requires app version ${manifest.min_app_version} or newer (current: ${appVersion}). Update the app to resume syncing writes.`,
    };
  }
  return { compatible: true };
}
