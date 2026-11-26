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
  });
});
