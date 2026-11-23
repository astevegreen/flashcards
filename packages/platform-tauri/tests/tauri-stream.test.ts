import { describe, expect, it } from 'vitest';
import { openTauriSaveStream, type TauriStreamDeps } from '../src/files/tauri-stream.ts';

function fakeFs(target: string | null) {
  const files = new Map<string, number[]>();
  const calls: Array<{ append: boolean | undefined; len: number }> = [];
  const deps: TauriStreamDeps = {
    save: async () => target,
    writeFile: async (path, data, opts) => {
      calls.push({ append: opts?.append, len: data.length });
      files.set(path, opts?.append ? [...(files.get(path) ?? []), ...data] : [...data]);
    },
  };
  return { files, calls, deps };
}

describe('Tauri streamed save', () => {
  it('creates the file on the first chunk and appends the rest in order', async () => {
    const fs = fakeFs('/out/a.zip');
    const sink = await openTauriSaveStream(fs.deps, 'a.zip');
    await sink?.write(new Uint8Array([1, 2]));
    await sink?.write(new Uint8Array([3]));
    await sink?.write(new Uint8Array([4, 5]));
    await sink?.close();
    expect(fs.calls.map((c) => c.append)).toEqual([false, true, true]);
    expect(fs.files.get('/out/a.zip')).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns null when the dialog is cancelled', async () => {
    const fs = fakeFs(null);
    expect(await openTauriSaveStream(fs.deps, 'a.zip')).toBeNull();
    expect(fs.calls).toEqual([]);
  });

  it('abort truncates the partial file to empty and rejects later writes', async () => {
    const fs = fakeFs('/out/a.zip');
    const sink = await openTauriSaveStream(fs.deps, 'a.zip');
    await sink?.write(new Uint8Array([1]));
    await sink?.write(new Uint8Array([2]));
    await sink?.abort();
    expect(fs.files.get('/out/a.zip')).toEqual([]);
    await expect(sink?.write(new Uint8Array([3]))).rejects.toThrow('closed');
    await expect(sink?.close()).rejects.toThrow('closed');
    expect(fs.files.get('/out/a.zip')).toEqual([]);
  });

  it('rejects writes after close', async () => {
    const fs = fakeFs('/out/a.zip');
    const sink = await openTauriSaveStream(fs.deps, 'a.zip');
    await sink?.write(new Uint8Array([1]));
    await sink?.close();
    await expect(sink?.write(new Uint8Array([2]))).rejects.toThrow('closed');
    expect(fs.files.get('/out/a.zip')).toEqual([1]);
  });

  it('writes an empty file when closed with no chunks', async () => {
    const fs = fakeFs('/out/a.zip');
    const sink = await openTauriSaveStream(fs.deps, 'a.zip');
    await sink?.close();
    expect(fs.files.get('/out/a.zip')).toEqual([]);
  });
});
