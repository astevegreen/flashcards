import type { WriterLocks } from '../../src/writer-lock.ts';

/**
 * A small `navigator.locks` with exclusive locks: `ifAvailable`, a waiting request with an abort
 * `signal`, and `steal` (the holder's request rejects with an AbortError). Releasing (the callback's
 * promise settling) hands the lock to the next waiter. `steals` counts steal requests.
 */
export function fakeLocks() {
  const held = new Map<string, (err: Error) => void>();
  const waiting = new Map<string, Array<() => void>>();
  const stats = { steals: 0 };
  const release = (name: string) => {
    held.delete(name);
    waiting.get(name)?.shift()?.();
  };
  const grant = (
    name: string,
    callback: (lock: unknown) => unknown,
    resolve: (v: unknown) => void,
    reject: (err: Error) => void,
  ) => {
    held.set(name, reject);
    void Promise.resolve(callback({ name })).then((v) => {
      if (held.get(name) === reject) release(name);
      resolve(v);
    });
  };
  const locks: WriterLocks = {
    request: (name, options, callback) =>
      new Promise((resolve, reject) => {
        const current = held.get(name);
        if (options.steal) {
          stats.steals++;
          current?.(new DOMException('stolen', 'AbortError'));
          grant(name, callback, resolve, reject);
        } else if (!current) {
          grant(name, callback, resolve, reject);
        } else if (options.ifAvailable) {
          resolve(callback(null));
        } else {
          // Like real Web Locks, an abort after the grant is ignored.
          const onAbort = () => {
            waiting.set(
              name,
              (waiting.get(name) ?? []).filter((t) => t !== turn),
            );
            reject(new DOMException('timed out', 'TimeoutError'));
          };
          const turn = () => {
            options.signal?.removeEventListener('abort', onAbort);
            grant(name, callback, resolve, reject);
          };
          waiting.set(name, [...(waiting.get(name) ?? []), turn]);
          options.signal?.addEventListener('abort', onAbort);
        }
      }),
  };
  return { locks, release, stats };
}
