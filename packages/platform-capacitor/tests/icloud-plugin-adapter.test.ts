import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CapacitorCore from '@capacitor/core';
import { bytesToBase64 } from '@flash/platform-web/base64';

// The adapter registers the Swift plugin through `registerPlugin`; capture what it forwards.
const readFile = vi.fn<(opts: { path: string; maxBytes?: number }) => Promise<{ data: string }>>();

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CapacitorCore>();
  return {
    ...actual,
    registerPlugin: (name: string) =>
      name === 'ICloudDocuments' ? { readFile } : actual.registerPlugin(name),
  };
});

const { createICloudDocumentPlugin } = await import('../src/native/plugins.ts');

describe('createICloudDocumentPlugin', () => {
  beforeEach(() => {
    readFile.mockReset();
    readFile.mockResolvedValue({ data: bytesToBase64(new Uint8Array([1, 2, 3])) });
  });

  it('forwards maxBytes to the native readFile and decodes the base64 body', async () => {
    const plugin = createICloudDocumentPlugin();
    const bytes = await plugin.readFile({ path: 'sync/v1/manifest.json', maxBytes: 4096 });
    expect(readFile).toHaveBeenCalledWith({ path: 'sync/v1/manifest.json', maxBytes: 4096 });
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('leaves maxBytes out when the caller gives none', async () => {
    await createICloudDocumentPlugin().readFile({ path: 'media/ab/x.mp3' });
    expect(readFile).toHaveBeenCalledWith({ path: 'media/ab/x.mp3' });
    expect(readFile.mock.calls[0]?.[0]).not.toHaveProperty('maxBytes');
  });

  it('passes a native TOO_LARGE rejection through unchanged', async () => {
    const tooLarge = Object.assign(new Error('too large'), { code: 'TOO_LARGE' });
    readFile.mockRejectedValue(tooLarge);
    await expect(
      createICloudDocumentPlugin().readFile({ path: 'sync/v1/manifest.json', maxBytes: 1 }),
    ).rejects.toBe(tooLarge);
  });
});
