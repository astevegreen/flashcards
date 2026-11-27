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

interface SqlResultLike {
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

const UNICASE = 'unicase';
const COLLATE = 'collate';

function asciiLower(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code >= 65 && code <= 90 ? String.fromCodePoint(code + 32) : ch;
  }
  return out;
}

function isSqlSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isIdentChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || ch === '_';
}

/** Start of the `COLLATE` (and the spaces before it) that `unicase` at `at` belongs to, or -1. */
function collateClauseStart(lower: string, at: number): number {
  if (isIdentChar(lower[at + UNICASE.length])) return -1;
  let end = at;
  while (end > 0 && isSqlSpace(lower[end - 1])) end -= 1;
  if (end === at || !lower.endsWith(COLLATE, end)) return -1;
  let start = end - COLLATE.length;
  if (isIdentChar(lower[start - 1])) return -1;
  while (start > 0 && isSqlSpace(lower[start - 1])) start -= 1;
  return start;
}

/** Removes every `COLLATE unicase` clause (any ASCII case or spacing) from a schema statement. */
export function stripUnicaseCollation(sql: string): string {
  const lower = asciiLower(sql);
  let out = '';
  let pos = 0;
  for (let at = lower.indexOf(UNICASE); at !== -1; at = lower.indexOf(UNICASE, at + 1)) {
    const start = collateClauseStart(lower, at);
    if (start === -1 || start < pos) continue;
    out += sql.slice(pos, start);
    pos = at + UNICASE.length;
  }
  return out + sql.slice(pos);
}

function sqlString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * Anki 2.1.50+ (schema 18) declares names `COLLATE unicase`, a collation Anki registers itself.
 * sql.js cannot register collations, and SQLite refuses to plan any query on a `WITHOUT ROWID`
 * table or index that uses a missing one, so the reader drops the clause from this throwaway
 * in-memory copy's schema. Only full-table reads follow, so the B-tree order is irrelevant.
 */
function dropUnicaseCollation(db: SqlDatabaseLike): void {
  const rows = db.exec("SELECT name, sql FROM sqlite_master WHERE sql LIKE '%unicase%'")[0];
  if (!rows || rows.values.length === 0) return;
  const version = Number(db.exec('PRAGMA schema_version')[0]?.values[0]?.[0] ?? 0);
  db.exec('PRAGMA writable_schema = ON');
  for (const [name, sql] of rows.values) {
    const stripped = sqlString(stripUnicaseCollation(String(sql)));
    db.exec(`UPDATE sqlite_master SET sql = ${stripped} WHERE name = ${sqlString(String(name))}`);
  }
  // Bumping the schema cookie makes SQLite reload the edited schema before the next query.
  db.exec(`PRAGMA schema_version = ${version + 1}`);
  db.exec('PRAGMA writable_schema = OFF');
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
    dropUnicaseCollation(db);
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
