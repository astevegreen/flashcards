/**
 * Pure TypeScript, zero-dependency RFC 4122 UUIDv5 (SHA-1) and RFC 9562 UUIDv7.
 * Strictly avoids DOM/WebCrypto/Node APIs so packages/core remains 100% pure TS
 * and deterministic card/note ID derivation stays synchronous during event replay.
 */

// Custom fixed namespace UUID for deterministic flashcard entity IDs
export const FLASH_NAMESPACE_UUID = '9c5c9c4e-6f12-4b64-a31f-2f2b74c4c101';

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function hexByte(bytes: Uint8Array, index: number): string {
  return HEX[bytes[index] ?? 0] ?? '00';
}

function bytesToUuid(bytes: Uint8Array): string {
  return (
    `${hexByte(bytes, 0)}${hexByte(bytes, 1)}${hexByte(bytes, 2)}${hexByte(bytes, 3)}-` +
    `${hexByte(bytes, 4)}${hexByte(bytes, 5)}-` +
    `${hexByte(bytes, 6)}${hexByte(bytes, 7)}-` +
    `${hexByte(bytes, 8)}${hexByte(bytes, 9)}-` +
    `${hexByte(bytes, 10)}${hexByte(bytes, 11)}${hexByte(bytes, 12)}${hexByte(bytes, 13)}${hexByte(bytes, 14)}${hexByte(bytes, 15)}`
  );
}

function uuidToBytes(uuid: string): Uint8Array {
  const clean = uuid.replace(/-/g, '').toLowerCase();
  if (clean.length !== 32 || !/^[0-9a-f]{32}$/.test(clean)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Pure-TS UTF-8 encoder (no TextEncoder DOM dependency). */
export function encodeUtf8(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let codePoint = str.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = ((codePoint - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

function rotl(n: number, bits: number): number {
  return (n << bits) | (n >>> (32 - bits));
}

/** Pure-TS SHA-1 implementation for RFC 4122 UUIDv5 (not used for cryptographic secrecy). */
function sha1(input: Uint8Array): Uint8Array {
  const len = input.length;
  const bitLen = len * 8;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(paddedLen);
  msg.set(input);
  msg[len] = 0x80;

  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Int32Array(80);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getInt32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl((w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0), 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotl(a, 5) + f + e + k + (w[i] ?? 0)) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, h0, false);
  outView.setInt32(4, h1, false);
  outView.setInt32(8, h2, false);
  outView.setInt32(12, h3, false);
  outView.setInt32(16, h4, false);
  return out;
}

/**
 * RFC 4122 UUIDv5: deterministic UUID from a namespace UUID and UTF-8 name.
 * If `namespace` is not a valid UUID string, it is first hashed under `FLASH_NAMESPACE_UUID`.
 */
export function uuidv5(namespace: string, name: string): string {
  const nsBytes = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(namespace)
    ? uuidToBytes(namespace)
    : uuidToBytes(uuidv5(FLASH_NAMESPACE_UUID, namespace));
  const nameBytes = encodeUtf8(name);
  const combined = new Uint8Array(nsBytes.length + nameBytes.length);
  combined.set(nsBytes, 0);
  combined.set(nameBytes, nsBytes.length);

  const hash = sha1(combined);
  const bytes = hash.slice(0, 16);
  // Set version 5 (0101)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  // Set variant RFC 4122 (10xx)
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

/** Deterministic card ID per blueprint §2.1: uuidv5(note_id, layout_id, variant). */
export function deriveCardId(noteId: string, layoutId: string, variant = 0): string {
  return uuidv5(noteId, `${layoutId}:${variant}`);
}

/** Deterministic note ID per blueprint §3.1: uuidv5(deck_id, source_key). */
export function deriveNoteId(deckId: string, sourceKey: string): string {
  return uuidv5(deckId, sourceKey);
}

// Monotonic state for UUIDv7
let lastV7Ms = -1;
let lastV7Seq = 0;

function nextRandomByte(): number {
  // Pure JS PRNG fallback; deterministic tests can pass explicit `randomBytes`.
  return Math.floor(Math.random() * 256);
}

/**
 * RFC 9562 UUIDv7: time-ordered monotonic 128-bit UUID.
 */
export function uuidv7(nowMs: number = Date.now(), randomBytes?: Uint8Array): string {
  let ms = Math.max(0, Math.floor(nowMs));
  if (ms === lastV7Ms) {
    lastV7Seq = (lastV7Seq + 1) & 0x0fff;
    if (lastV7Seq === 0) {
      ms += 1;
    }
  } else if (ms < lastV7Ms) {
    ms = lastV7Ms;
    lastV7Seq = (lastV7Seq + 1) & 0x0fff;
    if (lastV7Seq === 0) {
      ms += 1;
    }
  } else {
    lastV7Seq = 0;
  }
  lastV7Ms = ms;

  const bytes = new Uint8Array(16);
  // 48-bit big-endian Unix timestamp in ms
  bytes[0] = Math.floor(ms / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(ms / 0x100000000) & 0xff;
  bytes[2] = (ms >>> 24) & 0xff;
  bytes[3] = (ms >>> 16) & 0xff;
  bytes[4] = (ms >>> 8) & 0xff;
  bytes[5] = ms & 0xff;

  // Version 7 (0111) + 12-bit monotonic sequence in rand_a
  bytes[6] = 0x70 | ((lastV7Seq >>> 8) & 0x0f);
  bytes[7] = lastV7Seq & 0xff;

  // Variant 10xx + 62 random bits
  for (let i = 8; i < 16; i++) {
    bytes[i] = randomBytes ? (randomBytes[i - 8] ?? nextRandomByte()) : nextRandomByte();
  }
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  return bytesToUuid(bytes);
}

/** Reset monotonic state (only useful for deterministic unit tests). */
export function resetUuidv7StateForTesting(): void {
  lastV7Ms = -1;
  lastV7Seq = 0;
}
