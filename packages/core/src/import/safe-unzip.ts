import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import type { FlateError, UnzipFile } from 'fflate';
import {
  centralDirectoryNameRecords,
  decodeZipEntryName,
  localHeaderNameRecords,
  type CentralDirectoryName,
} from './zip-entries.ts';

/**
 * Streaming zip extraction for untrusted archives (`.flashpkg`, Anki `.apkg`; §13).
 * Pure TypeScript on top of `fflate`: path-traversal checks, a file-count cap, and per-file and
 * total byte caps that are enforced on the bytes actually inflated (never trusting the sizes a
 * zip header declares), plus a compressed-size cap on the archive itself.
 */

export interface ArchiveLimits {
  maxFiles: number;
  maxTotalUncompressedBytes: number;
  maxSingleFileBytes: number;
  maxCompressedBytes: number;
}

/** Builds the importer-specific error for a failed check (security vs. malformed input). */
export interface ArchiveErrorFactory {
  security(message: string): Error;
  invalid(message: string): Error;
}

/** Returns why `path` is unsafe as an archive entry name, or `undefined` when it is safe. */
export function unsafeArchivePathReason(path: string): string | undefined {
  if (!path || path.includes('\0')) return `Invalid empty or NUL path in archive.`;
  const first = path.charCodeAt(0);
  const isDriveLetter =
    path.length >= 2 &&
    path[1] === ':' &&
    ((first >= 65 && first <= 90) || (first >= 97 && first <= 122));
  if (path.startsWith('/') || path.startsWith('\\') || isDriveLetter) {
    return `Absolute path rejected in archive: "${path}"`;
  }
  if (path.includes('\\')) return `Backslash path separator rejected in archive: "${path}"`;
  if (path.split('/').includes('..')) return `Path traversal rejected in archive: "${path}"`;
  return undefined;
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Mutable bookkeeping shared by every entry of one extraction. */
interface UnzipRun {
  readonly limits: ArchiveLimits;
  readonly errors: ArchiveErrorFactory;
  readonly extracted: Map<string, Uint8Array>;
  /** Entry names in local-header order, as `fflate` read them. */
  readonly names: string[];
  readonly seenNames: Set<string>;
  /** fflate's name for an entry without the UTF-8 flag (Latin-1) -> `decodeZipEntryName`'s. */
  readonly rename: ReadonlyMap<string, string>;
  fileCount: number;
  declaredTotal: number;
  actualTotal: number;
  error: Error | null;
}

/** Header checks for one entry (cheap early exits; the inflated bytes are checked again). */
function checkEntryHeader(run: UnzipRun, name: string, declaredSize: number | undefined): void {
  const { limits, errors } = run;
  const reason = unsafeArchivePathReason(name);
  if (reason) throw errors.security(reason);
  // Two entries with one name: which one wins depends on the reader, so refuse both (C18).
  if (run.seenNames.has(name)) {
    throw errors.security(`Duplicate entry name rejected in archive: "${name}"`);
  }
  run.names.push(name);
  run.seenNames.add(name);
  run.fileCount += 1;
  if (run.fileCount > limits.maxFiles) {
    throw errors.security(`Archive exceeds maximum file count (${limits.maxFiles}).`);
  }
  if (declaredSize === undefined) return;
  if (declaredSize > limits.maxSingleFileBytes) {
    throw errors.security(
      `File "${name}" exceeds max single-file size (${limits.maxSingleFileBytes} bytes).`,
    );
  }
  run.declaredTotal += declaredSize;
  if (run.declaredTotal > limits.maxTotalUncompressedBytes) {
    throw errors.security(
      `Archive exceeds max uncompressed byte limit (${limits.maxTotalUncompressedBytes} bytes).`,
    );
  }
}

/** Counts one inflated chunk against the caps; returns an error instead of throwing. */
function countChunk(run: UnzipRun, name: string, fileBytes: number, size: number): Error | null {
  const { limits, errors } = run;
  if (fileBytes > limits.maxSingleFileBytes) {
    return errors.security(
      `Inflated file "${name}" exceeds max single-file size (${limits.maxSingleFileBytes} bytes).`,
    );
  }
  run.actualTotal += size;
  if (run.actualTotal > limits.maxTotalUncompressedBytes) {
    return errors.security(
      `Inflated archive exceeds max uncompressed byte limit (${limits.maxTotalUncompressedBytes} bytes).`,
    );
  }
  return null;
}

/** Collects one entry's inflated chunks, counting each against the caps as it arrives. */
class EntrySink {
  private readonly chunks: Uint8Array[] = [];
  private fileBytes = 0;

  private readonly run: UnzipRun;
  private readonly name: string;

  constructor(run: UnzipRun, name: string) {
    this.run = run;
    this.name = name;
  }

  onData(err: FlateError | null, chunk: Uint8Array, final: boolean): void {
    const { run } = this;
    if (run.error) return;
    if (err) {
      run.error = run.errors.invalid(`Failed to inflate "${this.name}": ${err.message}`);
      return;
    }
    if (chunk.byteLength > 0 && !this.accept(chunk)) return;
    if (final) run.extracted.set(this.name, concatChunks(this.chunks, this.fileBytes));
  }

  /** Counts and keeps `chunk`; false (with `run.error` set) once a cap is crossed. */
  private accept(chunk: Uint8Array): boolean {
    this.fileBytes += chunk.byteLength;
    this.run.error = countChunk(this.run, this.name, this.fileBytes, chunk.byteLength);
    if (this.run.error) return false;
    this.chunks.push(chunk);
    return true;
  }
}

/** Starts inflating one entry after its header passes the checks. */
function onEntry(run: UnzipRun, file: UnzipFile): void {
  if (run.error) return;
  try {
    const name = run.rename.get(file.name) ?? file.name;
    checkEntryHeader(run, name, file.originalSize);
    const sink = new EntrySink(run, name);
    file.ondata = (err, chunk, final) => sink.onData(err, chunk, final);
    file.start();
  } catch (err) {
    run.error = err instanceof Error ? err : new Error(String(err));
  }
}

/** Feeds the archive to `unzipper` in small chunks, stopping at the first recorded error. */
function pushAll(unzipper: Unzip, run: UnzipRun, archiveBytes: Uint8Array, label: string): void {
  const CHUNK_SIZE = 4096;
  try {
    for (let offset = 0; offset < archiveBytes.byteLength; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, archiveBytes.byteLength);
      unzipper.push(archiveBytes.subarray(offset, end), end >= archiveBytes.byteLength);
      if (run.error) throw run.error;
    }
  } catch (err) {
    if (run.error) throw run.error;
    throw run.errors.invalid(`Failed to unzip ${label}: ${describe(err)}`);
  }
}

/**
 * Format detection lists names from the central directory while extraction streams the local
 * headers. Refuses an archive where the two name different entries, so what was detected is what
 * gets imported (C18). An archive without a readable central directory has nothing to disagree with.
 */
function checkCentralDirectory(
  run: UnzipRun,
  central: readonly CentralDirectoryName[] | undefined,
): void {
  if (!central) return;
  // The same names, in any order (the format doesn't tie the two orders together). Local names
  // are already unique, so a matching count of distinct central names makes the multisets equal.
  const names = new Set(central.map(decodeZipEntryName));
  const matches =
    central.length === run.names.length &&
    names.size === central.length &&
    [...names].every((name) => run.seenNames.has(name));
  if (!matches) {
    throw run.errors.security(`Archive's central directory doesn't match its entries.`);
  }
}

/** Latin-1, the way fflate decodes a name without the UTF-8 flag. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCodePoint(b);
  return out;
}

/**
 * fflate decodes a name without the UTF-8 flag as Latin-1, while detection reads it as CP437 or
 * unflagged UTF-8 (`decodeZipEntryName`). Maps fflate's name to that one, so detection and
 * extraction agree. A Latin-1 name that a flagged entry also decodes to is left out: which entry
 * it came from is unknown, and the central directory check then refuses the archive.
 */
function unflaggedRenames(records: readonly CentralDirectoryName[]): Map<string, string> {
  const flagged = new Set<string>();
  const renames = new Map<string, string>();
  for (const record of records) {
    if (record.utf8) flagged.add(decodeZipEntryName(record));
    else renames.set(latin1(record.bytes), decodeZipEntryName(record));
  }
  for (const name of flagged) renames.delete(name);
  return renames;
}

/**
 * Extracts every entry of `archiveBytes` into memory, aborting mid-stream as soon as any cap is
 * crossed, so zip bombs with spoofed headers stop before exhausting memory.
 */
export function safeUnzip(
  archiveBytes: Uint8Array,
  limits: ArchiveLimits,
  errors: ArchiveErrorFactory,
  label = 'archive',
): Map<string, Uint8Array> {
  if (archiveBytes.byteLength > limits.maxCompressedBytes) {
    throw errors.security(
      `Archive exceeds max compressed size (${limits.maxCompressedBytes} bytes).`,
    );
  }
  if (archiveBytes.byteLength === 0) throw errors.invalid(`Empty ${label}.`);

  const central = centralDirectoryNameRecords(archiveBytes, limits.maxFiles + 1);
  const run: UnzipRun = {
    limits,
    errors,
    extracted: new Map(),
    names: [],
    seenNames: new Set(),
    rename: unflaggedRenames(central ?? localHeaderNameRecords(archiveBytes, limits.maxFiles + 1)),
    fileCount: 0,
    declaredTotal: 0,
    actualTotal: 0,
    error: null,
  };
  const unzipper = new Unzip((file) => onEntry(run, file));
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);
  pushAll(unzipper, run, archiveBytes, label);
  checkCentralDirectory(run, central);
  return run.extracted;
}
