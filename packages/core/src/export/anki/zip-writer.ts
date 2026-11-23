import { deflateSync } from 'fflate';
import { encodeUtf8 } from '../../ids.ts';

/**
 * A small streaming ZIP writer for the Anki exports. Each file is written out as soon as it is
 * added (local header, then its data), so a caller can read media one file at a time and pass
 * each chunk on (for example into Blob parts). Nothing holds every media file plus the finished
 * archive in memory at once, which large audio decks would not survive on a phone.
 *
 * Sizes and CRCs are written in the local headers (no data descriptors), so stream readers and
 * every unzip tool read the result. There is no ZIP64: an archive over 4 GiB or 65,535 files is
 * refused with an error. Pure (no I/O): the caller supplies the bytes and consumes the chunks.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (the ZIP / PNG polynomial). */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const UTF8_NAMES = 0x0800;

interface ZipEntry {
  name: Uint8Array;
  crc: number;
  size: number;
  compressedSize: number;
  method: number;
  offset: number;
}

/** DOS date and time (local fields read in UTC, so output does not depend on the device). */
function dosDateTime(ms: number): { date: number; time: number } {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (!Number.isFinite(ms) || year < 1980 || year > 2107) return { date: 0x21, time: 0 };
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

export class AnkiZipTooLargeError extends Error {
  constructor() {
    super('The export is too large for a ZIP file (over 4 GB or 65,535 files).');
    this.name = 'AnkiZipTooLargeError';
  }
}

/**
 * Receives the archive's bytes in order. It may return a promise that settles once the chunk is
 * written; `AnkiZipWriter.drain` waits for the latest one, which gives the writers backpressure.
 */
export type AnkiZipEmit = (chunk: Uint8Array) => unknown;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export class AnkiZipWriter {
  private readonly emit: AnkiZipEmit;
  private pending: Promise<void> | undefined;
  private failure: { error: unknown } | undefined;
  private readonly entries: ZipEntry[] = [];
  private readonly date: number;
  private readonly time: number;
  private offset = 0;
  private finished = false;

  /**
   * @param emit receives the archive's bytes in order; a chunk may be a file's own bytes, so
   *   copy it (a Blob part does) rather than modify it. A returned promise must settle only
   *   after every chunk emitted before it is written (a write queue does this).
   * @param modifiedMs the files' modification time (defaults to 1980-01-01).
   */
  constructor(emit: AnkiZipEmit, modifiedMs = Date.UTC(1980, 0, 1)) {
    this.emit = emit;
    const { date, time } = dosDateTime(modifiedMs);
    this.date = date;
    this.time = time;
  }

  /** Writes one file. `compress` deflates it (for text and SQLite; media is stored as is). */
  add(name: string, data: Uint8Array, compress = false): void {
    if (this.finished) throw new Error('ZIP already finished');
    const nameBytes = encodeUtf8(name);
    let body = data;
    let method = 0;
    if (compress) {
      const deflated = deflateSync(data, { level: 6 });
      if (deflated.length < data.length) {
        body = deflated;
        method = 8;
      }
    }
    const headerSize = 30 + nameBytes.length;
    if (
      this.entries.length >= MAX_ENTRIES ||
      data.length > MAX_U32 ||
      this.offset + headerSize + body.length > MAX_U32
    ) {
      throw new AnkiZipTooLargeError();
    }
    const entry: ZipEntry = {
      name: nameBytes,
      crc: crc32(data),
      size: data.length,
      compressedSize: body.length,
      method,
      offset: this.offset,
    };
    const header = new Uint8Array(headerSize);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, UTF8_NAMES, true);
    view.setUint16(8, method, true);
    view.setUint16(10, this.time, true);
    view.setUint16(12, this.date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.compressedSize, true);
    view.setUint32(22, entry.size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    this.push(header);
    if (body.length > 0) this.push(body);
    this.offset += headerSize + body.length;
    this.entries.push(entry);
  }

  /** Writes the central directory. No file can be added afterwards. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const size = this.entries.reduce((n, e) => n + 46 + e.name.length, 0);
    if (this.offset + size + 22 > MAX_U32) throw new AnkiZipTooLargeError();
    const out = new Uint8Array(size + 22);
    const view = new DataView(out.buffer);
    let p = 0;
    for (const e of this.entries) {
      view.setUint32(p, 0x02014b50, true);
      view.setUint16(p + 4, 20, true);
      view.setUint16(p + 6, 20, true);
      view.setUint16(p + 8, UTF8_NAMES, true);
      view.setUint16(p + 10, e.method, true);
      view.setUint16(p + 12, this.time, true);
      view.setUint16(p + 14, this.date, true);
      view.setUint32(p + 16, e.crc, true);
      view.setUint32(p + 20, e.compressedSize, true);
      view.setUint32(p + 24, e.size, true);
      view.setUint16(p + 28, e.name.length, true);
      // extra, comment, disk, internal and external attributes stay 0
      view.setUint32(p + 42, e.offset, true);
      out.set(e.name, p + 46);
      p += 46 + e.name.length;
    }
    view.setUint32(p, 0x06054b50, true);
    view.setUint16(p + 8, this.entries.length, true);
    view.setUint16(p + 10, this.entries.length, true);
    view.setUint32(p + 12, size, true);
    view.setUint32(p + 16, this.offset, true);
    this.push(out);
  }

  /** Waits until the chunks emitted so far are written (a no-op for a synchronous `emit`). */
  async drain(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) await pending;
    if (this.failure) throw this.failure.error;
  }

  private push(chunk: Uint8Array): void {
    if (this.failure) throw this.failure.error;
    const written = this.emit(chunk);
    // Every returned promise is observed; the first failure is thrown by `drain` and `add`.
    if (isPromiseLike(written)) {
      this.pending = Promise.resolve(written).then(
        () => undefined,
        (error: unknown) => {
          this.failure ??= { error };
        },
      );
    }
  }
}
