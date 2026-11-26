/**
 * Standard base64 (RFC 4648 §4, padded) over `btoa`/`atob`, for the web and native shells. Core
 * has its own pure base64url codec for licences (`@flash/core/license`).
 */

/** 32 KB slices keep `String.fromCharCode(...slice)` under the engine's argument limit. */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Throws on malformed input, as `atob` does (it ignores ASCII whitespace). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
