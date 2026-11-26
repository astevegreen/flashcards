/**
 * Pure-TS UTF-8 decoder (no TextDecoder DOM dependency). Apart from `ids.ts` (which has the
 * encoder) because only imports, backups, packs and sync need it, not the study screen (§8).
 *
 * Decodes like WHATWG `TextDecoder('utf-8')` in replacement mode (BOM kept): each maximal
 * invalid subsequence becomes one U+FFFD and decoding resumes at the byte that broke it, so a
 * bad byte never swallows the newline or JSON after it (D20).
 */
export function decodeUtf8(bytes: Uint8Array): string {
  let result = '';
  let cp = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] ?? 0;
    if (needed === 0) {
      i += 1;
      if (b < 0x80) {
        result += String.fromCharCode(b);
      } else if (b >= 0xc2 && b <= 0xdf) {
        needed = 1;
        cp = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2;
        cp = b & 0x0f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3;
        cp = b & 0x07;
      } else {
        result += '\uFFFD';
      }
      continue;
    }
    if (b < lower || b > upper) {
      // Not a valid continuation: the partial sequence is replaced and `b` is read again.
      cp = needed = seen = 0;
      lower = 0x80;
      upper = 0xbf;
      result += '\uFFFD';
      continue;
    }
    i += 1;
    lower = 0x80;
    upper = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    seen += 1;
    if (seen === needed) {
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        result += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      } else {
        result += String.fromCharCode(cp);
      }
      cp = needed = seen = 0;
    }
  }
  if (needed !== 0) result += '\uFFFD';
  return result;
}
