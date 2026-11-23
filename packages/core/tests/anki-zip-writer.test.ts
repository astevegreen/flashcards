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
});

describe('zip writer backpressure', () => {
  it('drain waits for the latest emitted promise; a synchronous emit drains at once', async () => {
    let release: (() => void) | undefined;
    const zip = new AnkiZipWriter(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    zip.add('a.txt', encodeUtf8('a'));
    let drained = false;
    const done = zip.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release?.();
    await done;
    expect(drained).toBe(true);
    const sync = new AnkiZipWriter(() => 1);
    sync.add('b.txt', encodeUtf8('b'));
    await expect(sync.drain()).resolves.toBeUndefined();
  });

  it('writeApkg reads the next media file only after the earlier chunks are written', async () => {
    const { writeApkg } = await import('../src/export/anki/apkg.ts');
    const log: string[] = [];
    let queue: Promise<void> = Promise.resolve();
    const emit = (chunk: Uint8Array) => {
      queue = queue.then(async () => {
        await new Promise((r) => setTimeout(r, 2));
        log.push(`wrote ${chunk.length}`);
      });
      return queue;
    };
    const media = ['a', 'b', 'c'].map((h) => ({ hash: h, name: `${h}.png`, mime: 'image/png' }));
    await writeApkg(
      encodeUtf8('sqlite'),
      { media, unknownMediaCount: 0, fileName: 'x.apkg' },
      async (hash) => {
        log.push(`read ${hash}`);
        return new Uint8Array(100);
      },
      emit,
    );
    // Each read comes after every write emitted before it.
    for (const hash of ['b', 'c']) {
      const at = log.indexOf(`read ${hash}`);
      expect(log.slice(at + 1).some((l) => l.startsWith('wrote'))).toBe(true);
      const before = log.slice(0, at);
      expect(before.at(-1)?.startsWith('wrote')).toBe(true);
    }
    expect(log.at(-1)?.startsWith('wrote')).toBe(true);
  });
});
