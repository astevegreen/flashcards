import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  decodePackArchive,
  PACK_SECURITY_LIMITS,
  PackValidationError,
  safeGunzipWithCap,
} from '../src/dictionary/pack-codec.ts';

/**
 * §13 gzip-bomb guards of the pack codec: the gzip trailer's ISIZE refuses an over-cap archive
 * before inflating it, and an explicit output counter refuses one whose trailer lies.
 */

const CAP = 64 * 1024;

/** Overwrites the gzip trailer's ISIZE (last 4 bytes, little-endian). */
function withTrailerSize(gz: Uint8Array, size: number): Uint8Array {
  const out = gz.slice();
  const n = out.byteLength;
  out[n - 4] = size & 0xff;
  out[n - 3] = (size >>> 8) & 0xff;
  out[n - 2] = (size >>> 16) & 0xff;
  out[n - 1] = (size >>> 24) & 0xff;
  return out;
}

describe('safeGunzipWithCap', () => {
  it('inflates an archive under the cap', () => {
    const raw = new Uint8Array(CAP).fill(65);
    expect(safeGunzipWithCap(gzipSync(raw), CAP)).toEqual(raw);
  });

  it('refuses an archive whose trailer declares more than the cap, before inflating', () => {
    // A gzip header, a body that is not valid deflate, and a trailer declaring 1 GB: had the
    // codec started inflating, fflate would report a deflate error instead of the cap.
    const header = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff];
    const garbage = new Array<number>(32).fill(0xff);
    const fake = withTrailerSize(
      new Uint8Array([...header, ...garbage, 0, 0, 0, 0, 0, 0, 0, 0]),
      0x40000000,
    );
    expect(() => safeGunzipWithCap(fake, CAP)).toThrow(/maximum uncompressed byte cap/);
  });

  it('counts the output itself when the trailer lies about the size', () => {
    const bomb = withTrailerSize(gzipSync(new Uint8Array(CAP * 8).fill(65)), 10);
    const err = (() => {
      try {
        safeGunzipWithCap(bomb, CAP);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PackValidationError);
    expect(String(err)).toMatch(/maximum uncompressed byte cap/);
  });

  it('refuses a bomb with an honest trailer through decodePackArchive', () => {
    const bomb = gzipSync(new Uint8Array(CAP * 4).fill(65));
    expect(() => decodePackArchive(bomb, { maxUncompressedBytes: CAP })).toThrow(
      /maximum uncompressed byte cap/,
    );
  });
});

describe('pack file-size cap', () => {
  it('refuses a plain JSON pack over the compressed cap, so pickers can cap at it', () => {
    const json = new TextEncoder().encode(`{"pad":"${'x'.repeat(CAP)}"}`);
    expect(() => decodePackArchive(json, { maxCompressedBytes: CAP })).toThrow(
      /exceeds maximum size/,
    );
    expect(PACK_SECURITY_LIMITS.maxCompressedBytes).toBeLessThan(
      PACK_SECURITY_LIMITS.maxUncompressedBytes,
    );
  });
});
