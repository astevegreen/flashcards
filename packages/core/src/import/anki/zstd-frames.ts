/**
 * Walks the frame and block headers of a Zstandard stream without decompressing it, so an
 * untrusted `.apkg` (anki21b) can be rejected before a decoder allocates its window buffer.
 * Each compressed block regenerates at most 128 KiB (RFC 8878 §3.1.1.2.4), which gives a safe
 * upper bound on the decompressed size.
 */

const ZSTD_MAGIC = 0xfd2fb528;
const BLOCK_MAX = 128 * 1024;

export interface ZstdStreamInfo {
  frames: number;
  /** Largest window any frame asks the decoder to allocate. */
  maxWindowBytes: number;
  /** Upper bound on the decompressed size of the whole stream. */
  maxOutputBytes: number;
}

export class ZstdFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZstdFrameError';
  }
}

function u32le(b: Uint8Array, at: number): number {
  return (
    ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)) +
    (b[at + 3] ?? 0) * 0x1000000
  );
}

function readLe(b: Uint8Array, at: number, length: number): number {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < length; i++) {
    value += (b[at + i] ?? 0) * scale;
    scale *= 256;
  }
  return value;
}

interface FrameHeader {
  headerBytes: number;
  windowBytes: number;
  checksum: boolean;
}

function readFrameHeader(b: Uint8Array, at: number): FrameHeader {
  const flags = b[at] ?? 0;
  const singleSegment = (flags >> 5) & 1;
  const checksum = ((flags >> 2) & 1) === 1;
  const dictFlag = flags & 3;
  const fcsFlag = flags >> 6;
  if (flags & 8) throw new ZstdFrameError('Reserved zstd frame header bit set');
  let pos = at + 1;
  let windowBytes = 0;
  if (!singleSegment) {
    const wd = b[pos] ?? 0;
    const base = 2 ** (10 + (wd >> 3));
    windowBytes = base + (base / 8) * (wd & 7);
    pos += 1;
  }
  pos += dictFlag === 3 ? 4 : dictFlag;
  const fcsBytes = fcsFlag === 0 ? singleSegment : 2 ** fcsFlag;
  if (fcsBytes > 0) {
    const fcs = readLe(b, pos, fcsBytes) + (fcsBytes === 2 ? 256 : 0);
    if (singleSegment) windowBytes = fcs;
  }
  pos += fcsBytes;
  if (pos > b.length) throw new ZstdFrameError('Truncated zstd frame header');
  return { headerBytes: pos - at, windowBytes, checksum };
}

/** Walks one frame's blocks; returns the offset after the frame and its output bound. */
function walkBlocks(b: Uint8Array, start: number): { end: number; output: number } {
  let pos = start;
  let output = 0;
  for (;;) {
    if (pos + 3 > b.length) throw new ZstdFrameError('Truncated zstd block header');
    const header = (b[pos] ?? 0) | ((b[pos + 1] ?? 0) << 8) | ((b[pos + 2] ?? 0) << 16);
    pos += 3;
    const last = (header & 1) === 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    if (type === 3) throw new ZstdFrameError('Reserved zstd block type');
    if (type === 0) {
      output += size;
      pos += size;
    } else if (type === 1) {
      output += size;
      pos += 1;
    } else {
      output += BLOCK_MAX;
      pos += size;
    }
    if (pos > b.length) throw new ZstdFrameError('Truncated zstd block');
    if (last) return { end: pos, output };
  }
}

/** Inspects every frame (skippable frames included) of a zstd stream. */
export function inspectZstdStream(bytes: Uint8Array): ZstdStreamInfo {
  const info: ZstdStreamInfo = { frames: 0, maxWindowBytes: 0, maxOutputBytes: 0 };
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 4 > bytes.length) throw new ZstdFrameError('Truncated zstd magic number');
    const magic = u32le(bytes, pos);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      pos += 8 + u32le(bytes, pos + 4);
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw new ZstdFrameError('Not a zstd stream');
    const header = readFrameHeader(bytes, pos + 4);
    const { end, output } = walkBlocks(bytes, pos + 4 + header.headerBytes);
    pos = end + (header.checksum ? 4 : 0);
    if (pos > bytes.length) throw new ZstdFrameError('Truncated zstd checksum');
    info.frames += 1;
    info.maxWindowBytes = Math.max(info.maxWindowBytes, header.windowBytes);
    info.maxOutputBytes += output;
  }
  if (info.frames === 0) throw new ZstdFrameError('Empty zstd stream');
  return info;
}

/** True when `bytes` starts with the zstd frame magic number. */
export function isZstd(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && u32le(bytes, 0) === ZSTD_MAGIC;
}

/**
 * Builds a valid zstd stream made of raw (stored) blocks. Used by fixtures and tests to create
 * anki21b packages deterministically without a compressor.
 */
export function encodeZstdRaw(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  const header = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58]); // no FCS, 2 MiB window
  blocks.push(header);
  let offset = 0;
  do {
    const size = Math.min(BLOCK_MAX - 1, data.length - offset);
    const last = offset + size >= data.length ? 1 : 0;
    const bh = (size << 3) | last; // type 0 = raw
    blocks.push(
      new Uint8Array([bh & 0xff, (bh >> 8) & 0xff, (bh >> 16) & 0xff]),
      data.subarray(offset, offset + size),
    );
    offset += size;
  } while (offset < data.length);
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
