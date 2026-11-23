import { describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, retryImport, waitForRetry } from '../src/lazy/retryImport.ts';

const chunkError = () =>
  new TypeError('Failed to fetch dynamically imported module: /assets/StatsScreen-abc.js');

describe('retryImport', () => {
  it('returns the first successful load without waiting', async () => {
    const wait = vi.fn(() => Promise.resolve());
    const loader = vi.fn(() => Promise.resolve('module'));
    await expect(retryImport(loader, { wait })).resolves.toBe('module');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('recovers from a transient failure after one wait', async () => {
    const waits: number[] = [];
    const wait = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValueOnce('module');
    await expect(retryImport(loader, { delaysMs: [10, 20], wait })).resolves.toBe('module');
    expect(loader).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([10]);
  });

  it('gives up after every delay is used and rethrows the last error', async () => {
    const waits: number[] = [];
    const wait = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const last = new Error('third');
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(last);
    await expect(retryImport(loader, { delaysMs: [5, 15], wait })).rejects.toBe(last);
    expect(loader).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([5, 15]);
  });

  it('does not retry when no delays are given', async () => {
    const loader = vi.fn(() => Promise.reject(chunkError()));
    await expect(retryImport(loader, { delaysMs: [] })).rejects.toThrow(/dynamically imported/);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('uses the real timer by default', async () => {
    vi.useFakeTimers();
    try {
      const loader = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(chunkError())
        .mockResolvedValueOnce('module');
      const result = retryImport(loader, { delaysMs: [1000] });
      await vi.advanceTimersByTimeAsync(999);
      expect(loader).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe('module');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waitForRetry', () => {
  it('resolves early when the browser comes back online', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    try {
      let done = false;
      const pending = waitForRetry(60_000).then(() => {
        done = true;
      });
      await Promise.resolve();
      expect(done).toBe(false);
      target.dispatchEvent(new Event('online'));
      await pending;
      expect(done).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('isChunkLoadError', () => {
  it('recognises the browsers’ chunk-load messages', () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
  });

  it('leaves ordinary bugs alone', () => {
    expect(
      isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')")),
    ).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});
