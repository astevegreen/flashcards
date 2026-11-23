/**
 * Anki's note checksum (`notes.csum`): the first 32 bits of SHA-1 over the stripped first field.
 * A small SHA-1 of its own (the one in `ids.ts` is private to the initial bundle, and exporting
 * it would grow that bundle, §8). Not used for secrecy.
 */

function rotl(n: number, bits: number): number {
  return (n << bits) | (n >>> (32 - bits));
}

/** The first 4 bytes of SHA-1(`input`), as an unsigned 32-bit integer. */
export function sha1First32(input: Uint8Array): number {
  const len = input.length;
  const padded = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(padded);
  msg.set(input);
  msg[len] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(padded - 8, Math.floor((len * 8) / 0x100000000), false);
  view.setUint32(padded - 4, (len * 8) >>> 0, false);

  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Int32Array(80);
  for (let offset = 0; offset < padded; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl((w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0), 1);
    }
    let [a, b, c, d, e] = h as [number, number, number, number, number];
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
      const t = (rotl(a, 5) + f + e + k + (w[i] ?? 0)) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h[0] = ((h[0] ?? 0) + a) | 0;
    h[1] = ((h[1] ?? 0) + b) | 0;
    h[2] = ((h[2] ?? 0) + c) | 0;
    h[3] = ((h[3] ?? 0) + d) | 0;
    h[4] = ((h[4] ?? 0) + e) | 0;
  }
  return (h[0] ?? 0) >>> 0;
}
