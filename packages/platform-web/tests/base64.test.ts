import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../src/base64.ts';

describe('bytesToBase64 / base64ToBytes', () => {
  it('round-trips any bytes, including inputs past one 32 KB chunk', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 70_000 }), (bytes) => {
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
      }),
      { numRuns: 40 },
    );
  });

  it('writes padded standard base64, as the per-byte versions it replaced did', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        expect(bytesToBase64(bytes)).toBe(btoa(bin));
      }),
    );
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
    expect(base64ToBytes('+/8=')).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });
});
