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
    await createPersistQueue().whenSaved();
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

  it('a failed write is logged and does not block the next or whenSaved', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const q = createPersistQueue();
    const log: string[] = [];
    void q.enqueue(() => Promise.reject(new Error('disk full')));
    void q.enqueue(() => {
      throw new Error('sync throw');
    });
    void q.enqueue(async () => {
      log.push('third');
    });
    await q.whenSaved();
    expect(log).toEqual(['third']);
    expect(err).toHaveBeenCalledTimes(2);
  });
});
