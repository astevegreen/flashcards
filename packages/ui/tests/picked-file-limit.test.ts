import { ANKI_IMPORT_LIMITS } from '@flash/core/anki';
import { BACKUP_ARCHIVE_LIMITS } from '@flash/core/backup';
import { PACK_SECURITY_LIMITS } from '@flash/core/dictionary';
import { describe, expect, it } from 'vitest';
import { formatMegabytes, tooLargeMessage } from '../src/components/pickedFileLimit.ts';

describe('picked file over the cap (P8)', () => {
  it('says nothing for a file that was read', () => {
    expect(tooLargeMessage({ name: 'deck.apkg' }, 1024, 'to import')).toBeNull();
  });

  it('names the file and the cap it is over', () => {
    expect(
      tooLargeMessage(
        { name: 'big.apkg', tooLarge: true },
        ANKI_IMPORT_LIMITS.maxCompressedBytes,
        'to import',
      ),
    ).toBe('"big.apkg" is too large to import (the limit is 300 MB).');
    expect(
      tooLargeMessage(
        { name: 'old.flashpkg', tooLarge: true },
        BACKUP_ARCHIVE_LIMITS.maxCompressedBytes,
        'to restore',
      ),
    ).toBe('"old.flashpkg" is too large to restore (the limit is 300 MB).');
    expect(formatMegabytes(PACK_SECURITY_LIMITS.maxUncompressedBytes)).toBe('150 MB');
  });
});
