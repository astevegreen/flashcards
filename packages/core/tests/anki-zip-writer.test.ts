import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { AnkiZipWriter, crc32 } from '../src/export/anki/zip-writer.ts';
import { unzipApkg } from '../src/import/anki/package.ts';
import { ANKI_IMPORT_LIMITS } from '../src/import/anki/types.ts';
import { encodeUtf8 } from '../src/ids.ts';
import { decodeUtf8 } from '../src/utf8-decode.ts';

function join(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

describe('streaming zip writer', () => {
  it('computes CRC-32', () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(encodeUtf8('123456789'))).toBe(0xcbf43926);
  });

  it('writes stored and deflated files that unzip back, with sizes in the local headers', () => {
    const chunks: Uint8Array[] = [];
    const media = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
    const zip = new AnkiZipWriter((c) => chunks.push(c.slice()), Date.UTC(2026, 10, 23, 12, 30));
    zip.add('notes.csv', encodeUtf8('a,b\r\n'.repeat(200)), true);
    zip.add('collection.media/日本.png', media);
    zip.add('empty.txt', new Uint8Array());
    zip.finish();
    const bytes = join(chunks);

    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(['notes.csv', 'collection.media/日本.png', 'empty.txt']);
    expect(decodeUtf8(files['notes.csv'] ?? new Uint8Array())).toBe('a,b\r\n'.repeat(200));
    expect(files['collection.media/日本.png']).toEqual(media);
    expect(files['empty.txt']).toEqual(new Uint8Array());

    // No data descriptors (flag bit 3); deflated text is smaller than stored.
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x08).toBe(0);
    expect(view.getUint16(8, true)).toBe(8);
    expect(view.getUint32(18, true)).toBeLessThan(view.getUint32(22, true));

    // The app's own hardened unzip (the one the Anki importer uses) reads it too.
    const unzipped = unzipApkg(bytes, ANKI_IMPORT_LIMITS);
    expect(unzipped.get('collection.media/日本.png')).toEqual(media);
  });

  it('refuses files after finish', () => {
    const zip = new AnkiZipWriter(() => {});
    zip.finish();
    expect(() => zip.add('a', new Uint8Array(1))).toThrow();
  });

  it('flush waits for every promise emit returned, and passes on a failure', async () => {
    const settle: (() => void)[] = [];
    const zip = new AnkiZipWriter(
      () =>
        new Promise<void>((resolve) => {
          settle.push(resolve);
        }),
    );
    zip.add('a', encodeUtf8('hello'));
    let flushed = false;
    const done = zip.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(settle).toHaveLength(2); // header and body
    expect(flushed).toBe(false);
    settle[0]?.();
    await Promise.resolve();
    expect(flushed).toBe(false);
    settle[1]?.();
    await done;
    expect(flushed).toBe(true);
    await zip.flush(); // nothing pending

    const failing = new AnkiZipWriter(() => Promise.reject(new Error('disk full')));
    failing.add('a', encodeUtf8('x'));
    await expect(failing.flush()).rejects.toThrow('disk full');
    await new AnkiZipWriter(() => {}).flush();
  });
});
