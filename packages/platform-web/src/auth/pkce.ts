/**
 * OAuth 2.0 PKCE helpers (RFC 7636) shared by the web auths and the Tauri loopback sign-ins (R3).
 * `cryptoImpl` is injectable so tests can pin the random bytes.
 */

import { bytesToBase64 } from '../base64.ts';

export interface PkceCrypto {
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array;
  subtle: { digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer> };
}

/** Unpadded base64url (RFC 4648 §5). */
export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** A random base64url string from `byteLength` random bytes (OAuth `state`, nonces). */
export function randomBase64Url(
  byteLength = 16,
  cryptoImpl: Pick<PkceCrypto, 'getRandomValues'> = crypto,
): string {
  return base64UrlEncode(cryptoImpl.getRandomValues(new Uint8Array(byteLength)));
}

/** A 32-byte verifier and its S256 challenge. */
export async function createPkcePair(
  cryptoImpl: PkceCrypto = crypto,
): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(32, cryptoImpl);
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}
