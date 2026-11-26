import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/sources/hash.ts';

const reference = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('sha256Hex', () => {
  it('matches node:crypto at every padding boundary', () => {
    const bytes = new Uint8Array(300).map((_, i) => (i * 31 + 7) & 0xff);
    for (let len = 0; len <= 300; len++) {
      expect(sha256Hex(bytes.subarray(0, len))).toBe(reference(bytes.subarray(0, len)));
    }
  });

  it('hashes a view into a larger buffer by its own bytes only', () => {
    const backing = new Uint8Array(1000).map((_, i) => i & 0xff);
    for (const [start, end] of [
      [3, 3],
      [5, 64 + 5],
      [17, 17 + 119],
      [1, 999],
    ] as const) {
      const view = backing.subarray(start, end);
      expect(sha256Hex(view)).toBe(reference(view));
    }
  });
});
