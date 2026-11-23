import { decodeUtf8 } from '../../utf8-decode.ts';
import { safeUnzip, type ArchiveErrorFactory } from '../safe-unzip.ts';
import {
  decodeProtobuf,
  protoBytesList,
  protoNumber,
  protoString,
  ProtobufError,
} from './protobuf.ts';
import {
  ANKI_REEXPORT_HINT,
  AnkiImportError,
  type AnkiCollectionFormat,
  type AnkiImportLimits,
} from './types.ts';
import { inspectZstdStream, ZstdFrameError } from './zstd-frames.ts';

/**
 * Pure archive-level planning for `.apkg` files: which collection file to read, how the media
 * map is encoded, and size checks for zstd payloads. The platform reader does the I/O (SQLite,
 * zstd) around these.
 */

export const APKG_ARCHIVE_ERRORS: ArchiveErrorFactory = {
  security: (message) => new AnkiImportError('unsafe_archive', `Unsafe Anki package: ${message}`),
  invalid: (message) =>
    new AnkiImportError('not_apkg', `This file is not a readable Anki package (${message}).`),
};

/** Unzips an untrusted `.apkg` under the Anki caps (path traversal, file count, byte caps). */
export function unzipApkg(bytes: Uint8Array, limits: AnkiImportLimits): Map<string, Uint8Array> {
  return safeUnzip(bytes, limits, APKG_ARCHIVE_ERRORS, 'Anki package');
}

export interface ApkgPlan {
  format: AnkiCollectionFormat;
  /** Zip entry holding the SQLite collection. */
  collectionEntry: string;
  /** Collection and media files are zstd-compressed (anki21b). */
  zstd: boolean;
}

/** `PackageMetadata.version` values (Anki `import_export.proto`). */
const META_VERSION_LATEST = 3;

function metaVersion(files: ReadonlyMap<string, Uint8Array>): number | undefined {
  const meta = files.get('meta');
  if (!meta) return undefined;
  try {
    return protoNumber(decodeProtobuf(meta), 1, 0);
  } catch {
    return undefined;
  }
}

/**
 * Picks the collection to import. Packages from current Anki carry `collection.anki21b` plus a
 * stub `collection.anki2` that only says "please update"; legacy exports carry
 * `collection.anki21` (2.1.x) and/or `collection.anki2`. The newest real one wins.
 */
export function planApkg(files: ReadonlyMap<string, Uint8Array>): ApkgPlan {
  const version = metaVersion(files);
  if (version !== undefined && version > META_VERSION_LATEST) {
    throw new AnkiImportError(
      'unsupported_format',
      `This Anki package was made by a newer Anki version than this app can read. ${ANKI_REEXPORT_HINT}`,
    );
  }
  if (files.has('collection.anki21b')) {
    return { format: 'anki21b', collectionEntry: 'collection.anki21b', zstd: true };
  }
  if (files.has('collection.anki21')) {
    return { format: 'anki21', collectionEntry: 'collection.anki21', zstd: false };
  }
  if (files.has('collection.anki2')) {
    return { format: 'anki2', collectionEntry: 'collection.anki2', zstd: false };
  }
  throw new AnkiImportError(
    'not_apkg',
    'This file does not contain an Anki collection. Choose an .apkg file exported from Anki.',
  );
}

/**
 * Rejects a zstd payload whose frames would make the decoder allocate or produce more than
 * `maxBytes` (checked from frame and block headers before any decompression).
 */
export function assertZstdWithinLimit(bytes: Uint8Array, maxBytes: number, label: string): void {
  let info;
  try {
    info = inspectZstdStream(bytes);
  } catch (err) {
    const why = err instanceof ZstdFrameError ? err.message : String(err);
    throw new AnkiImportError(
      'unsupported_format',
      `Could not read "${label}" in this Anki package (${why}). ${ANKI_REEXPORT_HINT}`,
    );
  }
  if (info.maxWindowBytes > maxBytes || info.maxOutputBytes > maxBytes) {
    throw new AnkiImportError(
      'too_large',
      `"${label}" in this Anki package is too large to import safely.`,
    );
  }
}

export interface AnkiMediaMapEntry {
  /** Name of the zip entry holding the bytes (`"0"`, `"1"`, …). */
  zipEntry: string;
  /** File name notes reference. */
  fileName: string;
}

function parseLegacyMediaMap(bytes: Uint8Array): AnkiMediaMapEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new AnkiImportError('not_apkg', 'The media list in this Anki package is damaged.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AnkiImportError('not_apkg', 'The media list in this Anki package is damaged.');
  }
  const out: AnkiMediaMapEntry[] = [];
  for (const [zipEntry, fileName] of Object.entries(parsed)) {
    if (typeof fileName === 'string' && fileName.length > 0) out.push({ zipEntry, fileName });
  }
  return out;
}

/** `MediaEntries { repeated MediaEntry entries = 1; }`, `MediaEntry { name = 1; … zip = 255 }`. */
function parseProtobufMediaMap(bytes: Uint8Array): AnkiMediaMapEntry[] {
  try {
    const entries = protoBytesList(decodeProtobuf(bytes), 1);
    const out: AnkiMediaMapEntry[] = [];
    entries.forEach((entryBytes, index) => {
      const entry = decodeProtobuf(entryBytes);
      const fileName = protoString(entry, 1);
      const legacyZip = entry.has(255) ? protoNumber(entry, 255) : index;
      if (fileName) out.push({ zipEntry: String(legacyZip), fileName });
    });
    return out;
  } catch (err) {
    if (!(err instanceof ProtobufError)) throw err;
    throw new AnkiImportError(
      'unsupported_format',
      `The media list in this Anki package uses a format this app cannot read. ${ANKI_REEXPORT_HINT}`,
    );
  }
}

/**
 * Parses the `media` map: JSON `{"0": "cat.jpg"}` in legacy packages, protobuf (already
 * zstd-decompressed by the reader) in anki21b packages.
 */
export function parseAnkiMediaMap(bytes: Uint8Array, zstd: boolean): AnkiMediaMapEntry[] {
  if (bytes.length === 0) return [];
  return zstd ? parseProtobufMediaMap(bytes) : parseLegacyMediaMap(bytes);
}
