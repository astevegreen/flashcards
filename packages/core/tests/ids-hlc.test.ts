import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareHlc, createHlcState, tickHlc } from '../src/hlc.ts';
import { parseHlc, receiveHlc } from '../src/hlc-merge.ts';
import {
  deriveCardId,
  deriveNoteId,
  encodeUtf8,
  FLASH_NAMESPACE_UUID,
  resetUuidv7StateForTesting,
  uuidv5,
  uuidv7,
} from '../src/ids.ts';

describe('UUIDv5 & UUIDv7 utilities', () => {
  it('generates RFC 4122 compliant deterministic UUIDv5', () => {
    // Known RFC 4122 DNS namespace + "www.example.com" vector (Section 4.3 / Errata)
    const DNS_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const v5 = uuidv5(DNS_NS, 'www.example.com');
    expect(v5).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');

    const c1 = deriveCardId(
      deriveNoteId(FLASH_NAMESPACE_UUID, 'row-1'),
      'layout:vocab-ko:recognition',
      0,
    );
    const c2 = deriveCardId(
      deriveNoteId(FLASH_NAMESPACE_UUID, 'row-1'),
      'layout:vocab-ko:recognition',
      0,
    );
    const c3 = deriveCardId(
      deriveNoteId(FLASH_NAMESPACE_UUID, 'row-1'),
      'layout:vocab-ko:production',
      0,
    );
    expect(c1).toBe(c2);
    expect(c1).not.toBe(c3);
    expect(c1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates monotonic strictly increasing UUIDv7 even within the same millisecond or clock rollback', () => {
    resetUuidv7StateForTesting();
    const fixedRand = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const a = uuidv7(1_700_000_000_000, fixedRand);
    const b = uuidv7(1_700_000_000_000, fixedRand);
    const c = uuidv7(1_699_999_999_000, fixedRand); // backwards clock
    const d = uuidv7(1_700_000_000_005, fixedRand);

    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(c < d).toBe(true);
  });
});

describe('Hybrid Logical Clock (HLC)', () => {
  it('ticks monotonically and merges remote HLCs cleanly across clock skew', () => {
    let devA = createHlcState('dev-a', 1000);
    const devB = createHlcState('dev-b', 5000); // B is 4 seconds ahead

    const t1 = tickHlc(devA, 1000);
    devA = t1.next;
    const t2 = tickHlc(devA, 1000);
    devA = t2.next;

    expect(compareHlc(t1.hlc, t2.hlc)).toBeLessThan(0);

    const tb = tickHlc(devB, 5000);

    // Dev A receives B's future HLC while A's wall clock is still 1000
    devA = receiveHlc(devA, tb.hlc, 1000);
    const t3 = tickHlc(devA, 1000);

    expect(compareHlc(tb.hlc, t3.hlc)).toBeLessThan(0);
    const parsed = parseHlc(t3.hlc);
    expect(parsed.wallMs).toBe(5000);
    expect(parsed.deviceId).toBe('dev-a');
  });
});

describe('encodeUtf8', () => {
  it('matches TextEncoder on well-formed text and keeps the old bytes for lone surrogates', () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (text) => {
        expect([...encodeUtf8(text)]).toEqual([...encoder.encode(text)]);
      }),
      { numRuns: 2000 },
    );
    // Ids hash these bytes, so a lone surrogate stays its own 3-byte sequence (not U+FFFD).
    const loneSurrogates = `${String.fromCharCode(0xd800)}a${String.fromCharCode(0xdc00)}`;
    expect([...encodeUtf8(loneSurrogates)]).toEqual([0xed, 0xa0, 0x80, 0x61, 0xed, 0xb0, 0x80]);
  });
});
