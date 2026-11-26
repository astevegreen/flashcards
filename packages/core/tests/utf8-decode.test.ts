import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../src/ids.ts';
import { decodeUtf8 } from '../src/utf8-decode.ts';

/** The WHATWG decoder every browser and Node ship (replacement mode, BOM kept like ours). */
const reference = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

describe('decodeUtf8 (D20)', () => {
  it('replaces an invalid byte with U+FFFD and keeps the bytes after it', () => {
    // A stray continuation byte, then a line break and JSON: nothing after the bad byte is lost.
    const bytes = new Uint8Array([0x80, 0x0a, 0x7b, 0x7d]);
    expect(decodeUtf8(bytes)).toBe('�\n{}');
  });

  it('does not swallow the next line after a truncated multi-byte sequence', () => {
    // `e3 81` is a cut-off three-byte sequence; the newline must still split the JSONL lines.
    const bytes = new Uint8Array([0x61, 0xe3, 0x81, 0x0a, 0x62]);
    expect(decodeUtf8(bytes).split('\n')).toEqual(['a�', 'b']);
  });

  it('rejects overlong, surrogate and out-of-range forms like TextDecoder', () => {
    const cases = [
      [0xc0, 0xaf], // overlong '/'
      [0xe0, 0x80, 0xaf], // overlong
      [0xed, 0xa0, 0x80], // UTF-16 surrogate
      [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
      [0xf8, 0x88, 0x80, 0x80, 0x80], // five-byte form
      [0xf0, 0x9f, 0x98], // truncated at the end
    ];
    for (const c of cases) {
      const bytes = new Uint8Array(c);
      expect(decodeUtf8(bytes)).toBe(reference.decode(bytes));
    }
  });

  it('round-trips any string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (s) => {
        expect(decodeUtf8(encodeUtf8(s))).toBe(reference.decode(encodeUtf8(s)));
      }),
    );
  });

  it('matches TextDecoder on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 48 }), (bytes) => {
        expect(decodeUtf8(bytes)).toBe(reference.decode(bytes));
      }),
      { numRuns: 2000 },
    );
  });
});
