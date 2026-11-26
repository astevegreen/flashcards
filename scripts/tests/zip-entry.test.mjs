import { describe, expect, it } from 'vitest';
import { safeZipEntryBaseName } from '../packs/zip-entry.mjs';

describe('safeZipEntryBaseName', () => {
  it('flattens an entry to its file name, with either separator', () => {
    expect(safeZipEntryBaseName('Unihan_Readings.txt')).toBe('Unihan_Readings.txt');
    expect(safeZipEntryBaseName('export/krdict_1.xml')).toBe('krdict_1.xml');
    expect(safeZipEntryBaseName('export\\krdict_2.xml')).toBe('krdict_2.xml');
    expect(safeZipEntryBaseName('a..b.xml')).toBe('a..b.xml');
  });

  it('skips traversal with forward, back or mixed separators, and directory entries', () => {
    for (const name of [
      '../evil.xml',
      '..\\..\\evil.xml',
      'ok/..\\evil.xml',
      'ok\\../evil.xml',
      'a/b/../../../evil.xml',
      '..',
      'dir/',
      'dir\\',
    ]) {
      expect(safeZipEntryBaseName(name)).toBeUndefined();
    }
  });

  it('skips a name with a colon (drive-relative path or NTFS stream) or a NUL byte', () => {
    for (const name of [
      'C:evil.xml',
      'C:\\Windows\\evil.xml',
      'dir/C:evil.xml',
      'krdict_1.xml:hidden',
      'export/krdict_1.xml::$DATA',
      'evil\0.xml',
    ]) {
      expect(safeZipEntryBaseName(name)).toBeUndefined();
    }
  });
});
