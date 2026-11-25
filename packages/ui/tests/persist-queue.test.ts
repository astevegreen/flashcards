import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersistQueue } from '../src/state/persistQueue.ts';

afterEach(() => vi.restoreAllMocks());

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('persist queue', () => {
  it('whenSaved resolves at once when nothing is queued', async () => {
    await expect(createPersistQueue().whenSaved()).resolves.toBeUndefined();
  });

  it('whenSaved resolves only after a slow write finished', async () => {
    const q = createPersistQueue();
    const slow = deferred();
    const log: string[] = [];
    void q.enqueue(async () => {
      await slow.promise;
      log.push('written');
    });
    const saved = q.whenSaved().then(() => log.push('saved'));
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual([]);
    slow.resolve();
    await saved;
    expect(log).toEqual(['written', 'saved']);
  });

  it('runs writes in order and waits for one queued while waiting', async () => {
    const q = createPersistQueue();
    const first = deferred();
    const log: string[] = [];
    void q.enqueue(async () => {
      await first.promise;
      log.push('first');
    });
    const saved = q.whenSaved().then(() => log.push('saved'));
    void q.enqueue(async () => {
      log.push('second');
    });
    first.resolve();
    await saved;
    expect(log).toEqual(['first', 'second', 'saved']);
  });

  it('a failed write is reported, does not block the next, and makes whenSaved reject', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onFailed = vi.fn();
    const q = createPersistQueue(onFailed);
    const log: string[] = [];
    void q.enqueue(() => Promise.reject(new Error('disk full')));
    void q.enqueue(() => {
      throw new Error('sync throw');
    });
    void q.enqueue(async () => {
      log.push('third');
    });
    await expect(q.whenSaved()).rejects.toThrow('2 change(s) could not be saved.');
    expect(log).toEqual(['third']);
    expect(err).toHaveBeenCalledTimes(2);
    expect(onFailed).toHaveBeenCalledTimes(2);
  });

  it('retryFailed runs the failed writes again in order, then whenSaved resolves', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const q = createPersistQueue();
    const log: string[] = [];
    let full = true;
    const write = (name: string) => async () => {
      if (full) throw new Error('disk full');
      log.push(name);
    };
    void q.enqueue(write('a'));
    void q.enqueue(write('b'));
    await expect(q.whenSaved()).rejects.toThrow();
    full = false;
    await q.retryFailed();
    expect(log).toEqual(['a', 'b']);
    await expect(q.whenSaved()).resolves.toBeUndefined();
  });

  it('retryFailed rejects and keeps the write when it fails again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onFailed = vi.fn();
    const q = createPersistQueue(onFailed);
    void q.enqueue(() => Promise.reject(new Error('disk full')));
    await expect(q.whenSaved()).rejects.toThrow();
    await expect(q.retryFailed()).rejects.toThrow('1 change(s) could not be saved.');
    expect(onFailed).toHaveBeenCalledTimes(2);
  });
});
