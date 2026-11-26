import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebFiles } from '../src/files/web-files.ts';

/** A stand-in `<input type="file">` whose click "picks" `file`. */
function stubFileInput(file: File): { arrayBuffer: ReturnType<typeof vi.fn> } {
  const arrayBuffer = vi.fn(() => file.arrayBuffer());
  const picked = { name: file.name, size: file.size, type: file.type, arrayBuffer };
  const input = Object.assign(new EventTarget(), {
    type: '',
    accept: '',
    files: [picked],
    click() {
      queueMicrotask(() => input.dispatchEvent(new Event('change')));
    },
  });
  vi.stubGlobal('document', { createElement: () => input });
  return { arrayBuffer };
}

describe('WebFiles.pickFile maxBytes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a file within the limit', async () => {
    const { arrayBuffer } = stubFileInput(new File([new Uint8Array([1, 2, 3])], 'a.csv'));
    const picked = await new WebFiles().pickFile({ maxBytes: 3 });
    expect(picked?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(picked?.tooLarge).toBeUndefined();
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it('never reads a file over the limit and reports it as too large', async () => {
    const { arrayBuffer } = stubFileInput(new File([new Uint8Array(10)], 'huge.apkg'));
    const picked = await new WebFiles().pickFile({ maxBytes: 9 });
    expect(picked).toEqual({
      name: 'huge.apkg',
      bytes: new Uint8Array(0),
      size: 10,
      tooLarge: true,
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects, instead of never settling, when reading the picked file fails', async () => {
    const { arrayBuffer } = stubFileInput(new File([new Uint8Array(3)], 'gone.csv'));
    arrayBuffer.mockRejectedValue(new DOMException('gone', 'NotFoundError'));
    await expect(new WebFiles().pickFile()).rejects.toThrow('gone');
  });

  it('without maxBytes reads any size, as before', async () => {
    stubFileInput(new File([new Uint8Array(10)], 'any.bin'));
    const picked = await new WebFiles().pickFile();
    expect(picked?.bytes.byteLength).toBe(10);
  });
});
