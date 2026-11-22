import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import type { FlateError, UnzipFile } from 'fflate';

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
    checkEntryHeader(run, file.name, file.originalSize);
    const sink = new EntrySink(run, file.name);
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

  const run: UnzipRun = {
    limits,
    errors,
    extracted: new Map(),
    fileCount: 0,
    declaredTotal: 0,
    actualTotal: 0,
    error: null,
  };
  const unzipper = new Unzip((file) => onEntry(run, file));
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);
  pushAll(unzipper, run, archiveBytes, label);
  return run.extracted;
}
