import type * as TauriFs from '@tauri-apps/plugin-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stat = vi.fn<(path: string) => Promise<{ size: number }>>();
const readFile = vi.fn<(path: string) => Promise<Uint8Array>>();

vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriFs>()),
  stat: (path: string) => stat(path),
  readFile: (path: string) => readFile(path),
}));

const { createFsBridge } = await import('../src/native/plugins.ts');

describe('createFsBridge readFileBytes', () => {
  beforeEach(() => {
    stat.mockReset();
    readFile.mockReset();
    readFile.mockResolvedValue(new Uint8Array([7]));
  });

  it('refuses a file over maxBytes with TOO_LARGE and its size, without reading it', async () => {
    stat.mockResolvedValue({ size: 2049 });
    const err = await createFsBridge()
      .readFileBytes('/sync/snapshots/a.json.gz', 2048)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 'TOO_LARGE', size: 2049 });
    expect((err as Error).message).toContain('2048');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('reads a file at exactly maxBytes', async () => {
    stat.mockResolvedValue({ size: 2048 });
    await expect(createFsBridge().readFileBytes('/a', 2048)).resolves.toEqual(new Uint8Array([7]));
    expect(readFile).toHaveBeenCalledWith('/a');
  });

  it('skips the size check when no maxBytes is given', async () => {
    await createFsBridge().readFileBytes('/a');
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith('/a');
  });
});
