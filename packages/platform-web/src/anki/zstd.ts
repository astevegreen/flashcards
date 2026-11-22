import { AnkiImportError } from '@flash/core/anki';
import { Decompress } from 'fzstd';

/**
 * Streams a zstd payload through `fzstd` (MIT, pure JS) and aborts as soon as the output passes
 * `maxBytes`, so a small anki21b file cannot expand without bound. Frame headers were already
 * checked by `assertZstdWithinLimit`, which keeps the decoder's window allocation bounded too.
 */
export function zstdDecompressCapped(bytes: Uint8Array, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  const stream = new Decompress((chunk) => {
    if (overflow) return;
    total += chunk.byteLength;
    if (total > maxBytes) {
      overflow = true;
      return;
    }
    chunks.push(chunk.slice());
  });
  const step = 64 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    const end = Math.min(offset + step, bytes.byteLength);
    stream.push(bytes.subarray(offset, end), end >= bytes.byteLength);
    if (overflow) {
      throw new AnkiImportError('too_large', 'A file in this Anki package is too large to import.');
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
