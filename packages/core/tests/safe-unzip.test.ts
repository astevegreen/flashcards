import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../src/ids.ts';
import { safeUnzip, type ArchiveErrorFactory } from '../src/import/safe-unzip.ts';
import { listZipEntryNames } from '../src/import/zip-entries.ts';

const LIMITS = {
  maxFiles: 10,
  maxTotalUncompressedBytes: 1024,
  maxSingleFileBytes: 1024,
  maxCompressedBytes: 4096,
};

class SecurityError extends Error {}
class InvalidError extends Error {}
const ERRORS: ArchiveErrorFactory = {
  security: (m) => new SecurityError(m),
  invalid: (m) => new InvalidError(m),
};

/** Stored (level 0) archive of `entry-one.txt` and `entry-two.txt`. */
function twoEntries(): Uint8Array {
  return zipSync(
    { 'entry-one.txt': encodeUtf8('111'), 'entry-two.txt': encodeUtf8('222') },
    { level: 0 },
  );
}

/** Offsets of every occurrence of `name` (local headers come first, then the central directory). */
function nameOffsets(bytes: Uint8Array, name: string): number[] {
  const needle = encodeUtf8(name);
  const out: number[] = [];
  for (let at = 0; at + needle.length <= bytes.length; at++) {
    if (needle.every((b, i) => bytes[at + i] === b)) out.push(at);
  }
  return out;
}

function rename(bytes: Uint8Array, at: number, name: string): void {
  bytes.set(encodeUtf8(name), at);
}

describe('safeUnzip duplicate and mismatched entries (C18, §13)', () => {
  it('extracts a clean archive and lists the same names detection sees', () => {
    const bytes = twoEntries();
    expect([...safeUnzip(bytes, LIMITS, ERRORS).keys()]).toEqual(listZipEntryNames(bytes));
    // Non-ASCII names (UTF-8 flag set) decode the same way on both sides.
    const hangul = zipSync({ '학교/사진.png': encodeUtf8('x'), 'café.txt': encodeUtf8('y') });
    expect([...safeUnzip(hangul, LIMITS, ERRORS).keys()]).toEqual(['학교/사진.png', 'café.txt']);
  });

  it('accepts a central directory that lists the same entries in another order', () => {
    // In-place updating tools rewrite the central directory in their own order; the zip format
    // doesn't tie it to the local-header order.
    const bytes = twoEntries();
    const eocd = bytes.length - 22;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = view.getUint32(eocd + 16, true);
    const size = view.getUint32(eocd + 12, true);
    const first = 46 + view.getUint16(start + 28, true) + view.getUint16(start + 30, true);
    const records = bytes.slice(start, start + size);
    bytes.set(records.subarray(first), start);
    bytes.set(records.subarray(0, first), start + size - first);
    expect(listZipEntryNames(bytes)).toEqual(['entry-two.txt', 'entry-one.txt']);
    expect([...safeUnzip(bytes, LIMITS, ERRORS).keys()]).toEqual([
      'entry-one.txt',
      'entry-two.txt',
    ]);
  });

  it('rejects two entries with the same name instead of keeping the last one', () => {
    const bytes = twoEntries();
    // Rename entry-two.txt to entry-one.txt in its local header and in the central directory.
    for (const at of nameOffsets(bytes, 'entry-two.txt')) rename(bytes, at, 'entry-one.txt');
    expect(listZipEntryNames(bytes)).toEqual(['entry-one.txt', 'entry-one.txt']);
    expect(() => safeUnzip(bytes, LIMITS, ERRORS)).toThrow(SecurityError);
    expect(() => safeUnzip(bytes, LIMITS, ERRORS)).toThrow(/duplicate/i);
  });

  it('rejects a central directory that names different entries than the local headers', () => {
    const bytes = twoEntries();
    const [, central] = nameOffsets(bytes, 'entry-two.txt');
    if (central === undefined) throw new Error('expected a central directory record');
    // Detection would see a name the importer never extracts.
    rename(bytes, central, 'entry-xyz.txt');
    expect(listZipEntryNames(bytes)).toEqual(['entry-one.txt', 'entry-xyz.txt']);
    expect(() => safeUnzip(bytes, LIMITS, ERRORS)).toThrow(SecurityError);
    // Same count, but one name twice: still not the same entries.
    rename(bytes, central, 'entry-one.txt');
    expect(() => safeUnzip(bytes, LIMITS, ERRORS)).toThrow(SecurityError);
  });
});

/** A stored archive of one ASCII-named entry, its name bytes then patched to `raw` everywhere. */
function unflaggedEntry(placeholder: string, raw: number[]): Uint8Array {
  const bytes = zipSync({ [placeholder]: encodeUtf8('x') }, { level: 0 });
  for (const at of nameOffsets(bytes, placeholder)) bytes.set(raw, at);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The UTF-8 flag (bit 11) is off in both the local header and the central directory record.
  expect(view.getUint16(6, true) & 0x800).toBe(0);
  const central = view.getUint32(bytes.length - 22 + 16, true);
  expect(view.getUint16(central + 8, true) & 0x800).toBe(0);
  return bytes;
}

describe('zip entry names without the UTF-8 flag', () => {
  it('reads a CP437 name the same way in detection and extraction', () => {
    // `café.txt` and `Ñ` in CP437: é is 0x82, Ñ is 0xA5 (not well-formed UTF-8).
    const raw = [...encodeUtf8('caf'), 0x82, 0xa5, ...encodeUtf8('.txt')];
    const bytes = unflaggedEntry('cafXY.txt', raw);
    expect(listZipEntryNames(bytes)).toEqual(['caféÑ.txt']);
    const extracted = safeUnzip(bytes, LIMITS, ERRORS);
    expect([...extracted.keys()]).toEqual(['caféÑ.txt']);
    expect(extracted.get('caféÑ.txt')).toEqual(encodeUtf8('x'));
  });

  it('reads a well-formed UTF-8 name without the flag as UTF-8 (macOS, Drive zips)', () => {
    const bytes = unflaggedEntry('XXXXXX.png', [...encodeUtf8('사진'), ...encodeUtf8('.png')]);
    expect(listZipEntryNames(bytes)).toEqual(['사진.png']);
    expect([...safeUnzip(bytes, LIMITS, ERRORS).keys()]).toEqual(['사진.png']);
  });

  it('decodes the same way from the local headers when there is no central directory', () => {
    const raw = [...encodeUtf8('caf'), 0x82, ...encodeUtf8('.txt')];
    const bytes = unflaggedEntry('cafX.txt', raw);
    const eocd = bytes.length - 22;
    bytes.fill(0, eocd, eocd + 4); // no EOCD record: both sides walk the local headers
    expect(listZipEntryNames(bytes)).toEqual(['café.txt']);
    expect([...safeUnzip(bytes, LIMITS, ERRORS).keys()]).toEqual(['café.txt']);
  });

  it('maps every CP437 byte to one character', () => {
    const bytes = unflaggedEntry(
      'X'.repeat(128),
      Array.from({ length: 128 }, (_, i) => 0x80 + i),
    );
    const [name] = listZipEntryNames(bytes) ?? [];
    expect([...(name ?? '')]).toHaveLength(128);
    expect(name?.startsWith('Çüé')).toBe(true);
    expect(name?.endsWith('²■ ')).toBe(true);
  });
});
