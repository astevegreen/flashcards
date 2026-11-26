import { describe, expect, it } from 'vitest';
import { readBodyCapped, readTextCapped } from '../src/net/read-capped.ts';

class TooLarge extends Error {
  constructor(readonly declared?: number) {
    super('too large');
  }
}
const tooLarge = (declared?: number) => new TooLarge(declared);

/** A body that hands out `chunks` one by one and records how many were pulled. */
function streamed(chunks: number[], headers?: Record<string, string>) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = chunks[pulled];
      if (size === undefined) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(pulled));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    res: new Response(body, headers ? { headers } : {}),
    pulled: () => pulled,
    cancelled: () => cancelled,
  };
}

describe('readBodyCapped (P8)', () => {
  it('returns the whole body when it fits', async () => {
    const { res } = streamed([3, 4]);
    const bytes = await readBodyCapped(res, 10, { tooLarge });
    expect([...bytes]).toEqual([1, 1, 1, 2, 2, 2, 2]);
  });

  it('refuses a declared Content-Length over the cap before reading', async () => {
    const s = streamed([1], { 'content-length': '11' });
    const err = await readBodyCapped(s.res, 10, { tooLarge }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooLarge);
    expect((err as TooLarge).declared).toBe(11);
    // A ReadableStream may pre-pull one chunk on its own; the reader takes none.
    expect(s.pulled()).toBeLessThanOrEqual(1);
  });

  it('stops pulling and cancels the stream as soon as the cap is passed', async () => {
    const s = streamed([6, 6, 6, 6, 6]);
    const err = await readBodyCapped(s.res, 10, { tooLarge }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooLarge);
    expect((err as TooLarge).declared).toBeUndefined();
    expect(s.pulled()).toBeLessThanOrEqual(3);
    expect(s.cancelled()).toBe(true);
  });

  it('ignores a lying Content-Length that is under the cap', async () => {
    const s = streamed([8, 8], { 'content-length': '4' });
    await expect(readBodyCapped(s.res, 10, { tooLarge })).rejects.toBeInstanceOf(TooLarge);
  });

  it('reports progress', async () => {
    const progress: Array<[number, number | undefined]> = [];
    await readBodyCapped(streamed([2, 3], { 'content-length': '5' }).res, 10, {
      tooLarge,
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });
    expect(progress).toEqual([
      [2, 5],
      [5, 5],
    ]);
  });

  it('caps a body without a stream reader', async () => {
    const fake = {
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => new Uint8Array(12).buffer,
    } as unknown as Response;
    await expect(readBodyCapped(fake, 10, { tooLarge })).rejects.toBeInstanceOf(TooLarge);
  });

  it('decodes text', async () => {
    await expect(readTextCapped(new Response('한글'), 100, { tooLarge })).resolves.toBe('한글');
  });
});
