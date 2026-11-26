import { describe, expect, it, vi } from 'vitest';
import { holdWriterLock, stopWriting, type WriterLocks } from '../src/writer-lock.ts';

interface Holder {
  reject: (err: Error) => void;
}

/**
 * A small `navigator.locks` for one exclusive lock name per test: `ifAvailable`, a waiting request
 * with an abort `signal`, and `steal` (the holder's request rejects with an AbortError).
 */
function fakeLocks() {
  const held = new Map<string, Holder>();
  const waiting = new Map<string, Array<() => void>>();
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
    held.set(name, { reject });
    void Promise.resolve(callback({ name })).then((v) => {
      if (held.get(name)?.reject === reject) release(name);
      resolve(v);
    });
  };
  const locks: WriterLocks = {
    request: (name, options, callback) =>
      new Promise((resolve, reject) => {
        const current = held.get(name);
        if (options.steal) {
          current?.reject(new DOMException('stolen', 'AbortError'));
          grant(name, callback, resolve, reject);
        } else if (!current) {
          grant(name, callback, resolve, reject);
        } else if (options.ifAvailable) {
          resolve(callback(null));
        } else {
          const turn = () => grant(name, callback, resolve, reject);
          waiting.set(name, [...(waiting.get(name) ?? []), turn]);
          options.signal?.addEventListener('abort', () => {
            waiting.set(
              name,
              (waiting.get(name) ?? []).filter((t) => t !== turn),
            );
            reject(new DOMException('timed out', 'TimeoutError'));
          });
        }
      }),
  };
  return { locks, release, held };
}

describe('holdWriterLock', () => {
  it('lets the first tab write and makes the second wait on the screen', async () => {
    const { locks } = fakeLocks();
    expect(await holdWriterLock(locks, 'flashcards-db', false, vi.fn(), 10)).toBe(true);
    expect(await holdWriterLock(locks, 'flashcards-db', false, vi.fn(), 10)).toBe(false);
  });

  it('keeps device-a and device-b as two separate writers', async () => {
    const { locks } = fakeLocks();
    expect(await holdWriterLock(locks, 'flashcards-db-a', false, vi.fn(), 10)).toBe(true);
    expect(await holdWriterLock(locks, 'flashcards-db-b', false, vi.fn(), 10)).toBe(true);
  });

  it('gets the lock when the old holder releases it within the wait (a reload)', async () => {
    const { locks, release } = fakeLocks();
    await holdWriterLock(locks, 'flashcards-db', false, vi.fn(), 10);
    const second = holdWriterLock(locks, 'flashcards-db', false, vi.fn(), 1000);
    release('flashcards-db');
    expect(await second).toBe(true);
  });

  it('falls back to ifAvailable without AbortSignal.timeout', async () => {
    const { locks } = fakeLocks();
    const timeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    try {
      expect(await holdWriterLock(locks, 'flashcards-db', false, vi.fn())).toBe(true);
      expect(await holdWriterLock(locks, 'flashcards-db', false, vi.fn())).toBe(false);
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { value: timeout, configurable: true });
    }
  });

  it('moves the lock on "Use here instead" and tells the old writer once', async () => {
    const { locks } = fakeLocks();
    const firstLost = vi.fn();
    const secondLost = vi.fn();
    await holdWriterLock(locks, 'flashcards-db', false, firstLost, 10);
    expect(await holdWriterLock(locks, 'flashcards-db', true, secondLost)).toBe(true);
    await vi.waitFor(() => expect(firstLost).toHaveBeenCalledTimes(1));
    expect(secondLost).not.toHaveBeenCalled();
    // ...and the first tab can take it back the same way.
    expect(await holdWriterLock(locks, 'flashcards-db', true, vi.fn())).toBe(true);
    await vi.waitFor(() => expect(secondLost).toHaveBeenCalledTimes(1));
  });

  it('writes as before when the lock manager fails outright', async () => {
    const locks: WriterLocks = { request: () => Promise.reject(new Error('SecurityError')) };
    const onLost = vi.fn();
    expect(await holdWriterLock(locks, 'flashcards-db', false, onLost)).toBe(true);
    expect(onLost).not.toHaveBeenCalled();
  });
});

describe('stopWriting', () => {
  class FakeStorage {
    writes = 0;
    async appendEvents() {
      this.writes++;
    }
    async appendEventsWithMeta() {
      this.writes++;
    }
    async setDeviceMeta() {
      this.writes++;
    }
    async setLocalSnapshot() {
      this.writes++;
    }
    async putMedia() {
      this.writes++;
    }
    async deleteKv() {
      this.writes++;
    }
    async clearAll() {
      this.writes++;
    }
    async openBackupStore() {
      this.writes++;
    }
    async getAllEvents() {
      return ['kept'];
    }
  }

  it('rejects every write, keeps reads, swallows hide events and reloads', async () => {
    const storage = new FakeStorage();
    const listeners: Array<[string, boolean | AddEventListenerOptions | undefined]> = [];
    const reload = vi.fn();
    const win = {
      addEventListener: (type: string, _l: unknown, opts?: boolean | AddEventListenerOptions) =>
        listeners.push([type, opts]),
      location: { reload },
    } as unknown as Window;

    stopWriting(storage, win);

    const writes = [
      storage.appendEvents(),
      storage.appendEventsWithMeta(),
      storage.setDeviceMeta(),
      storage.setLocalSnapshot(),
      storage.putMedia(),
      storage.deleteKv(),
      storage.clearAll(),
      storage.openBackupStore(),
    ];
    for (const write of writes) await expect(write).rejects.toThrow('open in another tab');
    expect(storage.writes).toBe(0);
    expect(await storage.getAllEvents()).toEqual(['kept']);
    expect(listeners).toEqual([
      ['pagehide', true],
      ['visibilitychange', true],
      ['focus', true],
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
