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
function hasZipSignature(bytes: Uint8Array): boolean {
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

/** CP437 for bytes 0x80–0xFF (the original IBM PC code page, the zip default for names). */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCodePoint(b) : (CP437_HIGH[b - 0x80] ?? '');
  return out;
}

/**
 * For a UTF-8 lead byte: how many continuation bytes follow, and the range the first one must
 * fall in (which rules out overlong forms, surrogates and > U+10FFFF). `undefined` when `b`
 * can't start a sequence.
 */
function utf8Lead(b: number): [needed: number, lower: number, upper: number] | undefined {
  if (b >= 0xc2 && b <= 0xdf) return [1, 0x80, 0xbf];
  if (b >= 0xe0 && b <= 0xef) return [2, b === 0xe0 ? 0xa0 : 0x80, b === 0xed ? 0x9f : 0xbf];
  if (b >= 0xf0 && b <= 0xf4) return [3, b === 0xf0 ? 0x90 : 0x80, b === 0xf4 ? 0x8f : 0xbf];
  return undefined;
}

/** Where the UTF-8 sequence that starts at `i` ends, or -1 when it is not well formed. */
function utf8SequenceEnd(bytes: Uint8Array, i: number): number {
  const b = bytes[i] ?? 0;
  if (b < 0x80) return i + 1;
  const lead = utf8Lead(b);
  if (!lead) return -1;
  const [needed, lower, upper] = lead;
  const first = bytes[i + 1];
  if (first === undefined || first < lower || first > upper) return -1;
  for (let k = 2; k <= needed; k++) {
    const c = bytes[i + k];
    if (c === undefined || c < 0x80 || c > 0xbf) return -1;
  }
  return i + 1 + needed;
}

/** True when `bytes` is well-formed UTF-8. */
function isWellFormedUtf8(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length;) {
    i = utf8SequenceEnd(bytes, i);
    if (i < 0) return false;
  }
  return true;
}
/**
 * One entry name, decoded the same way by detection and extraction:
 * - general-purpose flag bit 11 set: UTF-8;
 * - not set: CP437, as APPNOTE says, unless the bytes are well-formed UTF-8. macOS Archive
 *   Utility, Google Drive's "Download" zips and older Info-ZIP write UTF-8 names without the flag,
 *   while a real CP437 name with accented letters is almost never well-formed UTF-8 (`é` is a lone
 *   0x82, a continuation byte). Anki's own `.apkg` files set the flag (Python `zipfile`) and name
 *   media by number, so they never reach the fallback.
 */
export function decodeZipEntryName(name: CentralDirectoryName): string {
  const { bytes } = name;
  return name.utf8 || isWellFormedUtf8(bytes) ? decodeUtf8(bytes) : decodeCp437(bytes);
}

/** One central directory record's (or local header's) raw name. */
export interface CentralDirectoryName {
  bytes: Uint8Array;
  /** General-purpose flag bit 11: the name is UTF-8 (else CP437; see `decodeZipEntryName`). */
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

/** Raw names from the local headers, walked from the start (stops at anything it can't skip). */
export function localHeaderNameRecords(
  bytes: Uint8Array,
  maxEntries: number,
): CentralDirectoryName[] {
  const names: CentralDirectoryName[] = [];
  let at = 0;
  while (names.length < maxEntries && at + 30 <= bytes.length) {
    if (u32(bytes, at) !== LOCAL_SIGNATURE) break;
    const flags = u16(bytes, at + 6);
    const compressed = u32(bytes, at + 18);
    const nameLength = u16(bytes, at + 26);
    if (nameLength === 0 || at + 30 + nameLength > bytes.length) break;
    names.push({
      bytes: bytes.subarray(at + 30, at + 30 + nameLength),
      utf8: (flags & 0x800) !== 0,
    });
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
  const records =
    centralDirectoryNameRecords(bytes, maxEntries) ?? localHeaderNameRecords(bytes, maxEntries);
  return records.map(decodeZipEntryName);
}
