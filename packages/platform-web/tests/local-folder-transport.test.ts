import { isSyncTransportError } from '@flash/core';
import { describe, expect, it } from 'vitest';
import {
  LocalFolderSyncTransport,
  type FileSystemDirectoryHandleLike,
  type FileSystemFileHandleLike,
  type FileSystemWritableLike,
  type FsPermissionState,
} from '../src/sync/local-folder-transport.ts';
import { describeSyncTransportContract } from './helpers/sync-transport-contract.ts';

class MockFileHandle implements FileSystemFileHandleLike {
  readonly kind = 'file' as const;
  readonly name: string;
  data: Uint8Array;
  lastModified: number;

  constructor(name: string, data: Uint8Array = new Uint8Array(0)) {
    this.name = name;
    this.data = data;
    this.lastModified = Date.now();
  }

  async getFile() {
    const bytes = this.data;
    return {
      size: bytes.byteLength,
      lastModified: this.lastModified,
      async arrayBuffer() {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return copy.buffer;
      },
    };
  }

  async createWritable(): Promise<FileSystemWritableLike> {
    let nextBytes = new Uint8Array(0);
    return {
      write: async (data: BufferSource | Blob | string) => {
        if (data instanceof Uint8Array) {
          nextBytes = new Uint8Array(data);
        } else if (ArrayBuffer.isView(data)) {
          nextBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else if (data instanceof ArrayBuffer) {
          nextBytes = new Uint8Array(data);
        } else if (typeof data === 'string') {
          nextBytes = new TextEncoder().encode(data);
        } else {
          nextBytes = new Uint8Array(await data.arrayBuffer());
        }
      },
      close: async () => {
        this.data = nextBytes;
        this.lastModified = Date.now();
      },
    };
  }
}

class MockDirectoryHandle implements FileSystemDirectoryHandleLike {
  readonly kind = 'directory' as const;
  readonly name: string;
  private readonly children = new Map<string, MockDirectoryHandle | MockFileHandle>();
  permission: FsPermissionState;

  constructor(name: string, permission: FsPermissionState = 'granted') {
    this.name = name;
    this.permission = permission;
  }

  async queryPermission(): Promise<FsPermissionState> {
    return this.permission;
  }

  async requestPermission(): Promise<FsPermissionState> {
    return this.permission;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandleLike> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') {
        const err = new Error('TypeMismatch');
        err.name = 'TypeMismatchError';
        throw err;
      }
      return existing;
    }
    if (!options?.create) {
      const err = new Error('NotFound');
      err.name = 'NotFoundError';
      throw err;
    }
    const child = new MockDirectoryHandle(name, this.permission);
    this.children.set(name, child);
    return child;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandleLike> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') {
        const err = new Error('TypeMismatch');
        err.name = 'TypeMismatchError';
        throw err;
      }
      return existing;
    }
    if (!options?.create) {
      const err = new Error('NotFound');
      err.name = 'NotFoundError';
      throw err;
    }
    const file = new MockFileHandle(name);
    this.children.set(name, file);
    return file;
  }

  async *entries(): AsyncIterable<
    [string, FileSystemFileHandleLike | FileSystemDirectoryHandleLike]
  > {
    for (const [k, v] of this.children.entries()) {
      yield [k, v];
    }
  }
}

describeSyncTransportContract(
  'LocalFolderSyncTransport (mock directory handle)',
  () => new LocalFolderSyncTransport(new MockDirectoryHandle('FlashcardsSync', 'granted')),
);

describe('LocalFolderSyncTransport unit tests', () => {
  it('writes nested paths, enforces ifAbsent, lists by prefix, and reads back binary payloads', async () => {
    const root = new MockDirectoryHandle('FlashcardsSync');
    const transport = new LocalFolderSyncTransport(root);

    const seg = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    await transport.write(
      'sync/v1/manifest.json',
      new TextEncoder().encode('{"format_version":1}'),
      {
        ifAbsent: true,
      },
    );
    await transport.write('sync/v1/devices/dev-pc/seg-000001.jsonl.gz', seg, { ifAbsent: true });
    await transport.write(
      'sync/v1/devices/dev-pc/head.json',
      new TextEncoder().encode('{"last_seq":1}'),
    );

    await expect(
      transport.write('sync/v1/devices/dev-pc/seg-000001.jsonl.gz', seg, { ifAbsent: true }),
    ).rejects.toSatisfy((err) => isSyncTransportError(err) && err.code === 'ALREADY_EXISTS');

    expect(Array.from(await transport.read('sync/v1/devices/dev-pc/seg-000001.jsonl.gz'))).toEqual(
      Array.from(seg),
    );

    const listedDevices = await transport.list('sync/v1/devices/');
    expect(listedDevices.map((f) => f.path)).toEqual([
      'sync/v1/devices/dev-pc/head.json',
      'sync/v1/devices/dev-pc/seg-000001.jsonl.gz',
    ]);

    await expect(transport.read('sync/v1/missing.json')).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'NOT_FOUND',
    );
  });

  it('rejects path traversal and surfaces PERMISSION_DENIED when folder permission is not granted', async () => {
    const root = new MockDirectoryHandle('SyncRoot', 'granted');
    const transport = new LocalFolderSyncTransport(root);

    for (const badPath of [
      '../secret.json',
      'sync/../../evil',
      '/abs/path',
      'a\\b',
      'a\0b',
      'C:/x',
    ]) {
      await expect(transport.read(badPath)).rejects.toThrow();
      await expect(transport.write(badPath, new Uint8Array([1]))).rejects.toThrow();
    }

    root.permission = 'prompt';
    await expect(transport.list('sync/v1/')).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'PERMISSION_DENIED',
    );
    await expect(transport.write('sync/v1/manifest.json', new Uint8Array([1]))).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'PERMISSION_DENIED',
    );
  });
});
