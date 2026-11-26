import { decodeUtf8 } from '../utf8-decode.ts';

/**
 * Lists the entry names of a zip archive without inflating anything (Phase 14 "Bring my cards"
 * format detection). Reads the central directory found through the end-of-central-directory
 * record; if that is missing or damaged, walks the local file headers from the start instead.
 * Every offset is bounds-checked and at most `maxEntries` names are read, so hostile input can
 * only make it return early. Extraction itself always goes through `safeUnzip` and its caps.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}

/** True when `bytes` starts with a zip local file header or an empty-archive EOCD record. */
export function hasZipSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const sig = u32(bytes, 0);
  return sig === LOCAL_SIGNATURE || sig === EOCD_SIGNATURE;
}

function findEocd(bytes: Uint8Array): number {
  const last = bytes.length - EOCD_MIN_SIZE;
  const floor = Math.max(0, last - MAX_COMMENT);
  for (let at = last; at >= floor; at--) {
    if (u32(bytes, at) === EOCD_SIGNATURE) return at;
  }
  return -1;
}

function readName(bytes: Uint8Array, start: number, length: number): string | undefined {
  if (length === 0 || start + length > bytes.length) return undefined;
  return decodeUtf8(bytes.subarray(start, start + length));
}

/** One central directory record's raw name. */
export interface CentralDirectoryName {
  bytes: Uint8Array;
  /** General-purpose flag bit 11: the name is UTF-8 (else CP437, which readers take as Latin-1). */
  utf8: boolean;
}

/**
 * Raw entry names from the central directory (in directory order), or `undefined` when there is
 * no readable one. `safeUnzip` checks these against the local headers it extracts (C18).
 */
export function centralDirectoryNameRecords(
  bytes: Uint8Array,
  maxEntries: number,
): CentralDirectoryName[] | undefined {
  const eocd = findEocd(bytes);
  if (eocd === -1) return undefined;
  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  const names: CentralDirectoryName[] = [];
  for (let i = 0; i < count && names.length < maxEntries; i++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== CENTRAL_SIGNATURE) return undefined;
    const nameLength = u16(bytes, at + 28);
    if (nameLength === 0 || at + 46 + nameLength > bytes.length) return undefined;
    names.push({
      bytes: bytes.subarray(at + 46, at + 46 + nameLength),
      utf8: (u16(bytes, at + 8) & 0x800) !== 0,
    });
    at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
  }
  return names;
}

function centralDirectoryNames(bytes: Uint8Array, maxEntries: number): string[] | undefined {
  return centralDirectoryNameRecords(bytes, maxEntries)?.map((n) => decodeUtf8(n.bytes));
}

function localHeaderNames(bytes: Uint8Array, maxEntries: number): string[] {
  const names: string[] = [];
  let at = 0;
  while (names.length < maxEntries && at + 30 <= bytes.length) {
    if (u32(bytes, at) !== LOCAL_SIGNATURE) break;
    const flags = u16(bytes, at + 6);
    const compressed = u32(bytes, at + 18);
    const nameLength = u16(bytes, at + 26);
    const name = readName(bytes, at + 30, nameLength);
    if (name === undefined) break;
    names.push(name);
    // A streamed entry (data descriptor, size 0 in the header) cannot be skipped safely.
    if ((flags & 0x08) !== 0 && compressed === 0) break;
    at += 30 + nameLength + u16(bytes, at + 28) + compressed;
  }
  return names;
}

/**
 * Entry names of a zip archive (in archive order), or `undefined` when `bytes` is not a zip.
 * A damaged archive returns whatever names could be read (possibly none).
 */
export function listZipEntryNames(bytes: Uint8Array, maxEntries = 100_000): string[] | undefined {
  if (!hasZipSignature(bytes)) return undefined;
  return centralDirectoryNames(bytes, maxEntries) ?? localHeaderNames(bytes, maxEntries);
}
