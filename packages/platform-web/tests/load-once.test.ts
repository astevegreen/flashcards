import type { HandwritingRecognizer } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import { loadOnceUntilFailure } from '../src/load-once.ts';
import { LazyHandwritingRecognizer } from '../src/native-support.ts';

describe('loadOnceUntilFailure (C24)', () => {
  it('shares one load while it is pending or after it succeeds', async () => {
    const load = vi.fn(async () => 'ready');
    const get = loadOnceUntilFailure(load);
    await expect(Promise.all([get(), get()])).resolves.toEqual(['ready', 'ready']);
    await expect(get()).resolves.toBe('ready');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed load so the next call retries', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValue('ready');
    const get = loadOnceUntilFailure(load);
    await expect(get()).rejects.toThrow('Failed to fetch');
    await expect(get()).resolves.toBe('ready');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lets the lazy handwriting recognizer recover from a failed chunk load', async () => {
    const recognizer: HandwritingRecognizer = {
      id: 'offline',
      isNative: false,
      isReady: async () => true,
      recognize: async () => [],
    };
    const load = vi
      .fn<() => Promise<HandwritingRecognizer>>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(recognizer);
    const lazy = new LazyHandwritingRecognizer(load);
    await expect(lazy.isReady('ja')).rejects.toThrow('offline');
    await expect(lazy.isReady('ja')).resolves.toBe(true);
  });
});
