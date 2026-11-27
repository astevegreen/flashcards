import { PACK_SECURITY_LIMITS } from '@flash/core/pack-limits';
import { describe, expect, it } from 'vitest';
import { tooLargeMessage } from '../src/components/pickedFileLimit.ts';
import { MAX_PACK_PICK_BYTES } from '../src/packs/packPickLimit.ts';

describe('local pack pick cap (P8)', () => {
  it('caps the pick at the 50 MB file-size cap the codec enforces, not the 150 MB uncompressed one', () => {
    expect(MAX_PACK_PICK_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_PACK_PICK_BYTES).toBe(PACK_SECURITY_LIMITS.maxCompressedBytes);
    expect(MAX_PACK_PICK_BYTES).toBeLessThan(PACK_SECURITY_LIMITS.maxUncompressedBytes);
  });

  it('tells the user a 60 MB pack the picker refused unread is too large', () => {
    const picked = { name: 'jmdict.json.gz', tooLarge: true as const };
    expect(tooLargeMessage(picked, MAX_PACK_PICK_BYTES, 'for a dictionary pack')).toBe(
      '"jmdict.json.gz" is too large for a dictionary pack (the limit is 50 MB).',
    );
  });
});
