import {
  devicesPrefix,
  manifestPath,
  snapshotsPrefix,
  SYNC_CODEC_LIMITS,
  SYNC_MEDIA_LIMITS,
  SyncCodecError,
} from '@flash/core';
import { overCapText, readBodyCapped } from '../net/read-capped.ts';

/**
 * The most bytes an HTTP `SyncTransport.read()` buffers for each kind of sync file, so a lying
 * or huge download can't exhaust memory. Each cap sits well above what the sync codec reads
 * (`SYNC_CODEC_LIMITS`, `SYNC_MEDIA_LIMITS`): a file the engine would read still downloads as
 * before, and only a file far past any limit fails the read, with {@link SyncReadTooLargeError}.
 */
export const SYNC_READ_CAPS = {
  /**
   * `sync/v1/manifest.json` and `devices/<id>/head.json`: plain JSON. A head keeps one ~60-byte
   * range per segment its device ever pushed, with no pruning, so it grows with every push; the
   * cap is the most JSON the codec parses from any sync file (25 MiB, about 440k pushes).
   */
  head: SYNC_CODEC_LIMITS.maxUncompressedBytes,
  /** `devices/<id>/seg-NNNNNN.jsonl.gz`; the codec refuses gzipped files over 10 MiB. */
  segment: 2 * SYNC_CODEC_LIMITS.maxCompressedBytes,
  /** `snapshots/<id>-<seq>.json.gz`; no build uploads one the codec can't read (≤ 10 MiB). */
  snapshot: 3 * SYNC_CODEC_LIMITS.maxCompressedBytes,
  /** `media/<xx>/<sha256>.<ext>`; the engine skips blobs over 10 MiB with a warning. */
  media: 2 * SYNC_MEDIA_LIMITS.maxMediaBlobBytes,
} as const;

export type SyncFileKind = keyof typeof SYNC_READ_CAPS;

/** The kind of sync file at `path`; any other path gets the largest cap. */
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

  constructor(
    label: string,
    path: string,
    kind: SyncFileKind,
    maxBytes: number,
    declared?: number,
  ) {
    super(
      `${label} sync file "${path}" is too large to read (${overCapText(declared, maxBytes)}, the ${kind} limit).`,
    );
    this.name = 'SyncReadTooLargeError';
    this.path = path;
    this.kind = kind;
    this.maxBytes = maxBytes;
  }
}

/**
 * Reads a sync file's download body under its kind's cap. Over the cap it throws
 * {@link SyncReadTooLargeError} naming the file and its size, never a truncated body.
 */
export function readSyncBodyCapped(
  res: Response,
  path: string,
  label: string,
): Promise<Uint8Array> {
  const kind = syncFileKind(path);
  const maxBytes = SYNC_READ_CAPS[kind];
  return readBodyCapped(res, maxBytes, {
    tooLarge: (declared) => new SyncReadTooLargeError(label, path, kind, maxBytes, declared),
  });
}
