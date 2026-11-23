import { describe, expect, it } from 'vitest';
import { CapacitorFiles } from '../src/files/capacitor-files.ts';
import {
  createCapacitorSaveStream,
  type CapacitorStreamDeps,
} from '../src/files/capacitor-stream.ts';

function fakeFs() {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const shared: string[] = [];
  const deps: CapacitorStreamDeps = {
    writeFile: async ({ path, data }) => {
      calls.push('write');
      files.set(path, data);
      return { uri: `file:///cache/${path}` };
    },
    appendFile: async ({ path, data }) => {
      calls.push('append');
      files.set(path, (files.get(path) ?? '') + data);
    },
    deleteFile: async ({ path }) => {
      calls.push('delete');
      files.delete(path);
    },
    share: async ({ uri }) => void shared.push(uri),
  };
  return { files, calls, shared, deps };
}

const big = (fill: number) => new Uint8Array(600 * 1024).fill(fill);

describe('Capacitor streamed save', () => {
  it('appends chunks in order and shares on close', async () => {
    const fs = fakeFs();
    const sink = createCapacitorSaveStream(fs.deps, 'a.zip');
    await sink.write(big(1));
    await sink.write(big(2));
    await sink.write(new Uint8Array([3]));
    await sink.close();
    expect(fs.calls).toEqual(['write', 'append', 'append']);
    // Each appended piece is its own base64 string, so decode the concatenation piecewise.
    expect(fs.shared).toEqual(['file:///cache/a.zip']);
  });

  it('keeps byte order across appended pieces', async () => {
    const pieces: string[] = [];
    const fs = fakeFs();
    const deps: CapacitorStreamDeps = {
      ...fs.deps,
      writeFile: async (o) => {
        pieces.push(o.data);
        return { uri: 'u' };
      },
      appendFile: async (o) => void pieces.push(o.data),
    };
    const sink = createCapacitorSaveStream(deps, 'a.zip');
    await sink.write(big(1));
    await sink.write(big(2));
    await sink.write(new Uint8Array([3]));
    await sink.close();
    const decoded = pieces.map((p) => Uint8Array.from(atob(p), (c) => c.charCodeAt(0)));
    expect(decoded.map((d) => d.length)).toEqual([600 * 1024, 600 * 1024, 1]);
    expect(decoded[0]?.[0]).toBe(1);
    expect(decoded[1]?.[0]).toBe(2);
    expect(decoded[2]?.[0]).toBe(3);
  });

  it('joins small chunks before one bridge call', async () => {
    const fs = fakeFs();
    const sink = createCapacitorSaveStream(fs.deps, 'a.zip');
    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3]));
    await sink.close();
    expect(fs.calls).toEqual(['write']);
    expect(atob(fs.files.get('a.zip') as string)).toBe('\x01\x02\x03');
  });

  it('abort deletes the partial file and never shares', async () => {
    const fs = fakeFs();
    const sink = createCapacitorSaveStream(fs.deps, 'a.zip');
    await sink.write(big(1));
    await sink.write(big(2));
    await sink.abort();
    expect(fs.files.has('a.zip')).toBe(false);
    expect(fs.shared).toEqual([]);
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
