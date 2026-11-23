import { describe, expect, it } from 'vitest';
import { CapacitorFiles } from '../src/files/capacitor-files.ts';
import {
  createCapacitorSaveStream,
  type CapacitorStreamDeps,
} from '../src/files/capacitor-stream.ts';

function decode(b64: string): number[] {
  return [...Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))];
}

/** Stores real bytes: each call's base64 is decoded on its own, as the native plugin does. */
function fakeFs() {
  const files = new Map<string, number[]>();
  const calls: string[] = [];
  const shared: string[] = [];
  const deps: CapacitorStreamDeps = {
    writeFile: async ({ path, data }) => {
      calls.push('write');
      files.set(path, decode(data));
      return { uri: `file:///cache/${path}` };
    },
    appendFile: async ({ path, data }) => {
      calls.push('append');
      files.set(path, [...(files.get(path) ?? []), ...decode(data)]);
    },
    deleteFile: async ({ path }) => {
      calls.push('delete');
      files.delete(path);
    },
    share: async ({ uri }) => void shared.push(uri),
  };
  return { files, calls, shared, deps };
}

// Not a multiple of 3, so every piece ends in base64 padding.
const SIZE = 600 * 1024 + 1;
const big = (fill: number) => new Uint8Array(SIZE).fill(fill);

describe('Capacitor streamed save', () => {
  it('appends chunks in order and shares on close', async () => {
    const fs = fakeFs();
    const sink = createCapacitorSaveStream(fs.deps, 'a.zip');
    await sink.write(big(1));
    await sink.write(big(2));
    await sink.write(new Uint8Array([3, 4]));
    await sink.close();
    expect(fs.calls).toEqual(['write', 'append', 'append']);
    expect(fs.files.get('a.zip')).toEqual([
      ...new Array<number>(SIZE).fill(1),
      ...new Array<number>(SIZE).fill(2),
      3,
      4,
    ]);
    expect(fs.shared).toEqual(['file:///cache/a.zip']);
  });

  it('joins small chunks before one bridge call', async () => {
    const fs = fakeFs();
    const sink = createCapacitorSaveStream(fs.deps, 'a.zip');
    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3]));
    await sink.close();
    expect(fs.calls).toEqual(['write']);
    expect(fs.files.get('a.zip')).toEqual([1, 2, 3]);
  });

  it('abort deletes the partial file, never shares, and rejects later calls', async () => {
    const fs = fakeFs();
    const sink = createCapacitorSaveStream(fs.deps, 'a.zip');
    await sink.write(big(1));
    await sink.write(big(2));
    await sink.abort();
    expect(fs.files.has('a.zip')).toBe(false);
    expect(fs.shared).toEqual([]);
    await expect(sink.write(new Uint8Array([1]))).rejects.toThrow('closed');
    await expect(sink.close()).rejects.toThrow('closed');
    expect(fs.files.has('a.zip')).toBe(false);
  });

  it('exposes saveStream only when the bridge provides it', () => {
    const bridge = {
      pickFile: async () => null,
      saveAndShareFile: async () => undefined,
    };
    expect(new CapacitorFiles(bridge).saveStream).toBeUndefined();
    expect(new CapacitorFiles().saveStream).toBeUndefined();
    const fs = fakeFs();
    const withStream = new CapacitorFiles({
      ...bridge,
      openSaveStream: (name: string) => createCapacitorSaveStream(fs.deps, name),
    });
    expect(withStream.saveStream).toBeTypeOf('function');
  });
});
