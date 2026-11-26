// Offline tests for the upstream pack hash pins (S13).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertPinnedDownload,
  cachedCopyMatches,
  expectedSha256,
  sha256Hex,
} from '../packs/upstream-pins.mjs';

const bytes = Buffer.from('Unihan bytes');
const hash = sha256Hex(bytes);

describe('upstream pack pins (S13)', () => {
  it('fetches Unihan from a versioned, hash-pinned URL instead of latest', () => {
    const src = readFileSync(new URL('../fetch-upstream-packs.mjs', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\/UCD\/latest\//);
    expect(src).toMatch(/sha256: UNIHAN\.sha256/);
    expect(src).toMatch(/assertPinnedDownload\(/);
  });

  it('a repo pin must match', () => {
    const target = { file: 'Unihan.zip', version: '17.0.0', sha256: hash };
    expect(assertPinnedDownload(target, bytes, undefined)).toBe(hash);
    expect(() => assertPinnedDownload(target, Buffer.from('tampered'), undefined)).toThrow(
      /does not match the pinned/,
    );
    expect(cachedCopyMatches(target, Buffer.from('old latest'), undefined)).toBe(false);
  });

  it('an immutable version keeps the hash it was first fetched with', () => {
    const target = { file: 'kanjivg.xml.gz', version: 'r20250816' };
    expect(expectedSha256(target, { version: 'r20250816', sha256: hash })).toBe(hash);
    expect(() =>
      assertPinnedDownload(target, Buffer.from('changed'), { version: 'r20250816', sha256: hash }),
    ).toThrow(/does not match/);
    // A new release tag is a new version: no pin yet.
    expect(expectedSha256(target, { version: 'r20240807', sha256: hash })).toBeUndefined();
  });

  it('rolling sources are not pinned', () => {
    const target = { file: 'JMdict_e.gz' };
    expect(expectedSha256(target, { sha256: hash })).toBeUndefined();
    expect(assertPinnedDownload(target, Buffer.from('today'), { sha256: hash })).toBe(
      sha256Hex(Buffer.from('today')),
    );
  });
});
