import {
  ANKI_IMPORT_LIMITS,
  ANKI_REEXPORT_HINT,
  ANKI_TABLES,
  AnkiImportError,
  assertZstdWithinLimit,
  isZstd,
  parseAnkiMediaMap,
  planApkg,
  unzipApkg,
  type AnkiImportLimits,
  type AnkiMediaFile,
  type AnkiRawPackage,
  type AnkiSqlTable,
  type AnkiSqlValue,
  type AnkiTableName,
} from '@flash/core/anki';

/**
 * Reads an untrusted Anki `.apkg` into plain rows + media bytes (`AnkiRawPackage`). Runs inside
 * the Anki import Web Worker; the SQLite engine and zstd decoder are injected so Node tests can
 * drive the same code. Every cap from `ANKI_IMPORT_LIMITS` is enforced here: zip caps while
 * streaming, zstd frame checks before decompressing, decompressed byte counts, and row counts
 * before any table is copied.
 */

export interface SqlResultLike {
  columns: string[];
  values: AnkiSqlValue[][];
}

export interface SqlDatabaseLike {
  exec(sql: string): SqlResultLike[];
  close(): void;
}

export interface ApkgReaderDeps {
  openDatabase(bytes: Uint8Array): Promise<SqlDatabaseLike>;
  /** Decompresses a zstd stream, failing once more than `maxBytes` would be produced. */
  zstdDecompress(bytes: Uint8Array, maxBytes: number): Uint8Array;
}

export interface ApkgReadOptions {
  /** Skip copying the review log when history import is off. */
  includeReviewHistory?: boolean;
  limits?: Partial<AnkiImportLimits>;
}

const ROW_LIMITS: Partial<Record<AnkiTableName, keyof AnkiImportLimits>> = {
  notes: 'maxNotes',
  cards: 'maxCards',
  revlog: 'maxRevlog',
};

function decompress(
  deps: ApkgReaderDeps,
  bytes: Uint8Array,
  maxBytes: number,
  label: string,
): Uint8Array {
  assertZstdWithinLimit(bytes, maxBytes, label);
  try {
    return deps.zstdDecompress(bytes, maxBytes);
  } catch (err) {
    if (err instanceof AnkiImportError) throw err;
    throw new AnkiImportError(
      'unsupported_format',
      `Could not decompress "${label}" in this Anki package. ${ANKI_REEXPORT_HINT}`,
    );
  }
}

function tableNames(db: SqlDatabaseLike): Set<string> {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0];
  return new Set((result?.values ?? []).map((row) => String(row[0]).toLowerCase()));
}

function countRows(db: SqlDatabaseLike, table: AnkiTableName): number {
  const value = db.exec(`SELECT count(*) FROM "${table}"`)[0]?.values[0]?.[0];
  return typeof value === 'number' ? value : 0;
}

function readTables(
  db: SqlDatabaseLike,
  limits: AnkiImportLimits,
  includeReviewHistory: boolean,
): Partial<Record<AnkiTableName, AnkiSqlTable>> {
  const present = tableNames(db);
  const tables: Partial<Record<AnkiTableName, AnkiSqlTable>> = {};
  for (const name of ANKI_TABLES) {
    if (!present.has(name) || (name === 'revlog' && !includeReviewHistory)) continue;
    const limitKey = ROW_LIMITS[name];
    if (limitKey) {
      const count = countRows(db, name);
      if (count > limits[limitKey]) {
        throw new AnkiImportError(
          'too_large',
          `This Anki package has ${count} rows in "${name}"; the limit for one import is ${limits[limitKey]}. Export a smaller deck from Anki.`,
        );
      }
    }
    const result = db.exec(`SELECT * FROM "${name}"`)[0];
    tables[name] = { columns: result?.columns ?? [], rows: result?.values ?? [] };
  }
  return tables;
}

async function openCollection(deps: ApkgReaderDeps, bytes: Uint8Array): Promise<SqlDatabaseLike> {
  try {
    return await deps.openDatabase(bytes);
  } catch {
    throw new AnkiImportError(
      'invalid_collection',
      'The Anki collection in this file could not be opened.',
    );
  }
}

function readMedia(
  files: ReadonlyMap<string, Uint8Array>,
  zstd: boolean,
  deps: ApkgReaderDeps,
  limits: AnkiImportLimits,
): { media: AnkiMediaFile[]; warnings: string[] } {
  let mapBytes = files.get('media') ?? new Uint8Array(0);
  if (zstd && isZstd(mapBytes)) {
    mapBytes = decompress(deps, mapBytes, limits.maxSingleFileBytes, 'media');
  }
  const media: AnkiMediaFile[] = [];
  let missing = 0;
  let total = 0;
  for (const entry of parseAnkiMediaMap(mapBytes, zstd)) {
    const stored = files.get(entry.zipEntry);
    if (!stored) {
      missing += 1;
      continue;
    }
    const bytes =
      zstd && isZstd(stored)
        ? decompress(deps, stored, limits.maxSingleFileBytes, entry.fileName)
        : stored;
    total += bytes.byteLength;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new AnkiImportError(
        'too_large',
        'The media in this Anki package is too large to import.',
      );
    }
    media.push({ name: entry.fileName, bytes });
  }
  const warnings =
    missing > 0 ? [`${missing} media file(s) listed in the package are missing from it.`] : [];
  return { media, warnings };
}

/** Reads `.apkg` bytes into an `AnkiRawPackage` (see module docs for the safeguards). */
export async function readApkg(
  bytes: Uint8Array,
  deps: ApkgReaderDeps,
  options: ApkgReadOptions = {},
): Promise<AnkiRawPackage> {
  const limits: AnkiImportLimits = { ...ANKI_IMPORT_LIMITS, ...options.limits };
  const files = unzipApkg(bytes, limits);
  const plan = planApkg(files);
  let collectionBytes = files.get(plan.collectionEntry) ?? new Uint8Array(0);
  if (plan.zstd) {
    collectionBytes = decompress(
      deps,
      collectionBytes,
      limits.maxSingleFileBytes,
      plan.collectionEntry,
    );
  }
  const db = await openCollection(deps, collectionBytes);
  let tables: Partial<Record<AnkiTableName, AnkiSqlTable>>;
  try {
    tables = readTables(db, limits, options.includeReviewHistory === true);
  } catch (err) {
    if (err instanceof AnkiImportError) throw err;
    throw new AnkiImportError('invalid_collection', 'The Anki collection in this file is damaged.');
  } finally {
    db.close();
  }
  const { media, warnings } = readMedia(files, plan.zstd, deps, limits);
  return { format: plan.format, tables, media, warnings };
}
