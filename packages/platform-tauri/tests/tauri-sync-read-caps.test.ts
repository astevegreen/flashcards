import { SYNC_READ_CAPS, SyncReadTooLargeError } from '@flash/core';
import { ICloudDriveSyncTransport } from '@flash/platform-capacitor';
import { describe, expect, it } from 'vitest';
import {
  createTauriICloudDocumentPlugin,
  TauriFolderSyncTransport,
  type TauriFsBridge,
  type TauriInvoke,
} from '../src/index.ts';

const SEGMENT = 'sync/v1/devices/dev-a/seg-000001.jsonl.gz';
const HEAD = 'sync/v1/devices/dev-a/head.json';

/** A desktop fs bridge over sizes only, refusing past `maxBytes` like `createDesktopFsBridge`. */
function fakeBridge(sizes: Map<string, number>, honoursMaxBytes: boolean) {
  const reads: Array<{ absPath: string; maxBytes: number | undefined }> = [];
  const bridge: TauriFsBridge = {
    pickDirectory: async () => null,
    listDirectoryFiles: async () => [],
    readFileBytes: async (absPath, maxBytes) => {
      reads.push({ absPath, maxBytes });
      const size = sizes.get(absPath) ?? 0;
      if (honoursMaxBytes && maxBytes !== undefined && size > maxBytes) {
        throw Object.assign(new Error(`File exceeds ${maxBytes} bytes`), {
          code: 'TOO_LARGE',
          size,
        });
      }
      return new Uint8Array(size);
    },
    writeFileBytes: async () => {},
    moveFile: async () => {},
  };
  return { bridge, reads };
}

describe('TauriFolderSyncTransport read caps', () => {
  it('passes each file kind cap to the bridge', async () => {
    const { bridge, reads } = fakeBridge(new Map([[`/sync/${SEGMENT}`, 4]]), true);
    const transport = new TauriFolderSyncTransport('/sync', bridge);
    expect((await transport.read(SEGMENT)).byteLength).toBe(4);
    await transport.read(HEAD);
    expect(reads).toEqual([
      { absPath: `/sync/${SEGMENT}`, maxBytes: SYNC_READ_CAPS.segment },
      { absPath: `/sync/${HEAD}`, maxBytes: SYNC_READ_CAPS.head },
    ]);
  });

  it('turns the bridge TOO_LARGE rejection into SyncReadTooLargeError with the size', async () => {
    const size = SYNC_READ_CAPS.segment + 1;
    const { bridge } = fakeBridge(new Map([[`/sync/${SEGMENT}`, size]]), true);
    await expect(new TauriFolderSyncTransport('/sync', bridge).read(SEGMENT)).rejects.toSatisfy(
      (err) =>
        err instanceof SyncReadTooLargeError &&
        err.kind === 'segment' &&
        err.message.includes(`${size} > ${SYNC_READ_CAPS.segment}`),
    );
  });

  it('still refuses an oversized file from a bridge that ignores maxBytes', async () => {
    const { bridge } = fakeBridge(
      new Map([[`/sync/${SEGMENT}`, SYNC_READ_CAPS.segment + 1]]),
      false,
    );
    await expect(
      new TauriFolderSyncTransport('/sync', bridge).read(SEGMENT),
    ).rejects.toBeInstanceOf(SyncReadTooLargeError);
  });

  it('passes other bridge errors through', async () => {
    const { bridge } = fakeBridge(new Map(), true);
    bridge.readFileBytes = async () => {
      throw new Error('disk gone');
    };
    await expect(new TauriFolderSyncTransport('/sync', bridge).read(SEGMENT)).rejects.toThrow(
      'disk gone',
    );
  });
});

describe('Tauri iCloud read caps', () => {
  it('sends maxBytes to icloud_read_file and maps the Rust TOO_LARGE error', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    const invoke = (async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      const { maxBytes } = args as { path: string; maxBytes?: number };
      if (maxBytes !== undefined && maxBytes < SYNC_READ_CAPS.head) {
        throw { code: 'TOO_LARGE', message: 'over' };
      }
      return new Uint8Array([1]).buffer;
    }) as TauriInvoke;
    const transport = new ICloudDriveSyncTransport(createTauriICloudDocumentPlugin(invoke));

    expect(Array.from(await transport.read(HEAD))).toEqual([1]);
    await expect(transport.read(SEGMENT)).rejects.toBeInstanceOf(SyncReadTooLargeError);
    expect(calls).toEqual([
      { cmd: 'icloud_read_file', args: { path: HEAD, maxBytes: SYNC_READ_CAPS.head } },
      { cmd: 'icloud_read_file', args: { path: SEGMENT, maxBytes: SYNC_READ_CAPS.segment } },
    ]);
  });
});
