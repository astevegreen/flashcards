import { SYNC_READ_CAPS, SyncReadTooLargeError, syncReadCap } from '@flash/core';
import { describe, expect, it } from 'vitest';
import {
  ICloudDriveSyncTransport,
  type ICloudDocumentPlugin,
} from '../src/sync/icloud-transport.ts';

const SEGMENT = 'sync/v1/devices/dev-a/seg-000001.jsonl.gz';
const MEDIA = `media/ab/${'ab'.repeat(32)}.png`;

/** A plugin over sizes only: `readFile` hands back `size` zero bytes, or refuses like iOS does. */
function fakePlugin(sizes: Map<string, number>, honoursMaxBytes: boolean) {
  const reads: Array<{ path: string; maxBytes?: number }> = [];
  const plugin: ICloudDocumentPlugin = {
    listFiles: async () => [],
    readFile: async (opts) => {
      reads.push(opts);
      const size = sizes.get(opts.path) ?? 0;
      if (honoursMaxBytes && opts.maxBytes !== undefined && size > opts.maxBytes) {
        throw Object.assign(new Error(`"${opts.path}" is ${size} bytes`), { code: 'TOO_LARGE' });
      }
      return new Uint8Array(size);
    },
    writeFile: async () => {},
  };
  return { plugin, reads };
}

describe('ICloudDriveSyncTransport read caps', () => {
  it('asks the native plugin to refuse each file past its kind cap', async () => {
    const { plugin, reads } = fakePlugin(new Map([[SEGMENT, 3]]), true);
    const transport = new ICloudDriveSyncTransport(plugin);
    expect((await transport.read(`/${SEGMENT}`)).byteLength).toBe(3);
    await transport.read(MEDIA);
    expect(reads).toEqual([
      { path: SEGMENT, maxBytes: SYNC_READ_CAPS.segment },
      { path: MEDIA, maxBytes: SYNC_READ_CAPS.media },
    ]);
  });

  it('turns the plugin TOO_LARGE rejection into SyncReadTooLargeError', async () => {
    const { plugin } = fakePlugin(new Map([[SEGMENT, SYNC_READ_CAPS.segment + 1]]), true);
    await expect(new ICloudDriveSyncTransport(plugin).read(SEGMENT)).rejects.toSatisfy(
      (err) =>
        err instanceof SyncReadTooLargeError &&
        err.kind === 'segment' &&
        err.path === SEGMENT &&
        err.maxBytes === syncReadCap(SEGMENT).maxBytes,
    );
  });

  it('still refuses an oversized file from a plugin that ignores maxBytes', async () => {
    const { plugin } = fakePlugin(new Map([[SEGMENT, SYNC_READ_CAPS.segment + 1]]), false);
    await expect(new ICloudDriveSyncTransport(plugin).read(SEGMENT)).rejects.toBeInstanceOf(
      SyncReadTooLargeError,
    );
  });
});
