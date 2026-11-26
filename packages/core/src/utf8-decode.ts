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
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++] ?? 0;
    const lead = b < 0x80 ? null : leadByte(b);
    if (!lead) {
      result += b < 0x80 ? String.fromCodePoint(b) : '\uFFFD';
      continue;
    }
    let [needed, cp, lower, upper] = lead;
    while (needed > 0) {
      const c = bytes[i];
      // Not a valid continuation: the partial sequence is replaced and `c` is read again.
      if (c === undefined || c < lower || c > upper) break;
      cp = (cp << 6) | (c & 0x3f);
      i += 1;
      needed -= 1;
      lower = 0x80;
      upper = 0xbf;
    }
    result += needed === 0 ? String.fromCodePoint(cp) : '\uFFFD';
  }
  return result;
}

/**
 * For a valid lead byte: the continuation bytes it needs, its payload bits, and the range the
 * first continuation must fall in (which rules out overlong forms, surrogates and > U+10FFFF).
 */
function leadByte(b: number): [number, number, number, number] | null {
  if (b >= 0xc2 && b <= 0xdf) return [1, b & 0x1f, 0x80, 0xbf];
  if (b >= 0xe0 && b <= 0xef) {
    return [2, b & 0x0f, b === 0xe0 ? 0xa0 : 0x80, b === 0xed ? 0x9f : 0xbf];
  }
  if (b >= 0xf0 && b <= 0xf4) {
    return [3, b & 0x07, b === 0xf0 ? 0x90 : 0x80, b === 0xf4 ? 0x8f : 0xbf];
  }
  return null;
}
