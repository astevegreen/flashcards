import {
  devicesPrefix,
  manifestPath,
  snapshotsPrefix,
  SYNC_CODEC_LIMITS,
  SYNC_MEDIA_LIMITS,
  SyncCodecError,
} from './codec.ts';

/**
 * The limits a sync run reads files under: the codec's (`SYNC_CODEC_LIMITS`, or the engine's
 * `snapshotLimits` override) and the media check's (`maxMediaBlobBytes`).
 */
export interface SyncReadLimits {
  codec?: Partial<typeof SYNC_CODEC_LIMITS>;
  maxMediaBlobBytes?: number;
}

/**
 * The read caps that sit above `limits`. Each cap sits well above what the codec or the media
 * check reads, so a file the engine would read still downloads, and only a file far past any
 * limit fails the read.
 */
export function syncReadCapsFor(limits: SyncReadLimits = {}): Record<SyncFileKind, number> {
  const compressed = limits.codec?.maxCompressedBytes ?? SYNC_CODEC_LIMITS.maxCompressedBytes;
  const uncompressed = limits.codec?.maxUncompressedBytes ?? SYNC_CODEC_LIMITS.maxUncompressedBytes;
  const media = limits.maxMediaBlobBytes ?? SYNC_MEDIA_LIMITS.maxMediaBlobBytes;
  return {
    // `sync/v1/manifest.json` and `devices/<id>/head.json`: plain JSON, capped at the most JSON
    // the codec parses from any sync file (25 MiB by default).
    head: uncompressed,
    // `devices/<id>/seg-NNNNNN.jsonl.gz`: the codec refuses gzipped files over `compressed`.
    segment: 2 * compressed,
    // `snapshots/<id>-<seq>.json.gz`: no build uploads one the codec can't read.
    snapshot: 3 * compressed,
    // `media/<xx>/<sha256>.<ext>`: the engine skips larger blobs with a warning.
    media: 2 * media,
  };
}

/**
 * The most bytes a `SyncTransport.read()` takes in for each kind of sync file, so a lying or huge
 * file can't exhaust memory. Derived from the default limits (`SYNC_CODEC_LIMITS`,
 * `SYNC_MEDIA_LIMITS`); `runSync` refuses limit overrides these caps would not cover
 * ({@link assertSyncReadCapsCover}), so the two can't drift apart.
 */
export const SYNC_READ_CAPS: Readonly<Record<SyncFileKind, number>> =
  /* @__PURE__ */ syncReadCapsFor();

export type SyncFileKind = 'head' | 'segment' | 'snapshot' | 'media';

/** The kind of sync file at `path`; any other path gets the snapshot cap. */
export function syncFileKind(path: string): SyncFileKind {
  if (path === manifestPath()) return 'head';
  if (path.startsWith(snapshotsPrefix())) return 'snapshot';
  if (path.startsWith(devicesPrefix())) {
    if (path.endsWith('/head.json')) return 'head';
    if (path.endsWith('.jsonl.gz')) return 'segment';
  }
  if (path.startsWith('media/')) return 'media';
  return 'snapshot';
}

/** The read cap for the sync file at `path`, with its kind. */
export function syncReadCap(path: string): { kind: SyncFileKind; maxBytes: number } {
  const kind = syncFileKind(path);
  return { kind, maxBytes: SYNC_READ_CAPS[kind] };
}

/**
 * Throws a `RangeError` when `limits` would let the engine accept a file larger than a
 * transport reads ({@link SYNC_READ_CAPS}): such a file would fail at the transport, not at the
 * engine's own check. Raise the caps (or the defaults they derive from) instead.
 */
export function assertSyncReadCapsCover(limits: SyncReadLimits): void {
  const needed = syncReadCapsFor(limits);
  for (const kind of ['snapshot', 'media'] as const) {
    if (needed[kind] > SYNC_READ_CAPS[kind]) {
      throw new RangeError(
        `Sync ${kind} limit override needs a ${needed[kind]}-byte read cap, past the transports' ${SYNC_READ_CAPS[kind]}.`,
      );
    }
  }
}

function overCapText(size: number | undefined, maxBytes: number): string {
  return size === undefined ? `more than ${maxBytes} bytes` : `${size} > ${maxBytes} bytes`;
}

/**
 * A sync file past its kind's read cap. It is a `SyncCodecError`, so the engine handles it as it
 * handles a file past the codec's or the media limit: a snapshot candidate is skipped, a segment
 * ends that device's pull with a warning, a media blob is skipped with a warning, and a head or
 * the manifest fails the sync as a corrupt one does.
 */
export class SyncReadTooLargeError extends SyncCodecError {
  readonly path: string;
  readonly kind: SyncFileKind;
  readonly maxBytes: number;

  constructor(label: string, path: string, kind: SyncFileKind, maxBytes: number, size?: number) {
    super(
      `${label} sync file "${path}" is too large to read (${overCapText(size, maxBytes)}, the ${kind} limit).`,
    );
    this.name = 'SyncReadTooLargeError';
    this.path = path;
    this.kind = kind;
    this.maxBytes = maxBytes;
  }
}

/** Throws {@link SyncReadTooLargeError} when `size` bytes is past the read cap for `path`. */
export function assertSyncReadSize(label: string, path: string, size: number): void {
  const { kind, maxBytes } = syncReadCap(path);
  if (size > maxBytes) throw new SyncReadTooLargeError(label, path, kind, maxBytes, size);
}
