import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64UrlEncode, createPkcePair, randomBase64Url } from '../src/auth/pkce.ts';

describe('PKCE helpers (R3)', () => {
  it('encodes unpadded base64url', () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(base64UrlEncode(new Uint8Array([1]))).toBe('AQ');
  });

  it('makes a 43-character verifier whose S256 challenge matches RFC 7636', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('uses the injected random source', () => {
    const fixed = { getRandomValues: (a: Uint8Array<ArrayBuffer>) => a.fill(0xff) };
    expect(randomBase64Url(3, fixed)).toBe('____');
  });
});
