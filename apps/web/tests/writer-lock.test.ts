import { describe, expect, it, vi } from 'vitest';
import { holdWriterLock, usableLocks, waitUpTo, type WriterLocks } from '../src/writer-lock.ts';
import { fakeLocks } from './helpers/fake-locks.ts';

describe('holdWriterLock', () => {
  it('lets the first tab write and makes the second wait on the screen', async () => {
    const { locks } = fakeLocks();
    expect(await holdWriterLock(locks, 'flashcards-db', waitUpTo(10), vi.fn())).toBeTypeOf(
      'function',
    );
    expect(await holdWriterLock(locks, 'flashcards-db', waitUpTo(10), vi.fn())).toBeNull();
  });

  it('keeps device-a and device-b as two separate writers', async () => {
    const { locks } = fakeLocks();
    expect(await holdWriterLock(locks, 'flashcards-db-a', waitUpTo(10), vi.fn())).not.toBeNull();
    expect(await holdWriterLock(locks, 'flashcards-db-b', waitUpTo(10), vi.fn())).not.toBeNull();
  });

  it('gets the lock when the holder releases it within the wait (a reload, a handoff)', async () => {
    const { locks } = fakeLocks();
    const release = await holdWriterLock(locks, 'flashcards-db', waitUpTo(10), vi.fn());
    const second = holdWriterLock(locks, 'flashcards-db', waitUpTo(1000), vi.fn());
    release?.();
    expect(await second).not.toBeNull();
  });

  it('falls back to ifAvailable without AbortSignal.timeout', async () => {
    const { locks } = fakeLocks();
    const timeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    try {
      expect(waitUpTo(500)).toEqual({ ifAvailable: true });
      expect(await holdWriterLock(locks, 'flashcards-db', waitUpTo(500), vi.fn())).not.toBeNull();
      expect(await holdWriterLock(locks, 'flashcards-db', waitUpTo(500), vi.fn())).toBeNull();
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { value: timeout, configurable: true });
    }
  });

  it('tells the holder once when another tab steals the lock', async () => {
    const { locks } = fakeLocks();
    const firstLost = vi.fn();
    const secondLost = vi.fn();
    await holdWriterLock(locks, 'flashcards-db', waitUpTo(10), firstLost);
    expect(
      await holdWriterLock(locks, 'flashcards-db', { steal: true }, secondLost),
    ).not.toBeNull();
    await vi.waitFor(() => expect(firstLost).toHaveBeenCalledTimes(1));
    expect(secondLost).not.toHaveBeenCalled();
  });

  it('writes as before when the lock manager rejects outright', async () => {
    const locks: WriterLocks = { request: () => Promise.reject(new Error('SecurityError')) };
    const onLost = vi.fn();
    expect(await holdWriterLock(locks, 'flashcards-db', waitUpTo(10), onLost)).toBeTypeOf(
      'function',
    );
    expect(onLost).not.toHaveBeenCalled();
  });

  it('writes as before when the lock manager throws synchronously', async () => {
    const locks: WriterLocks = {
      request: () => {
        throw new TypeError('locks unavailable');
      },
    };
    expect(await holdWriterLock(locks, 'flashcards-db', waitUpTo(10), vi.fn())).toBeTypeOf(
      'function',
    );
  });
});

describe('usableLocks', () => {
  it('returns navigator.locks only when it has a request function', () => {
    const locks = { request: vi.fn() };
    expect(usableLocks({ locks } as unknown as Navigator)).toBe(locks);
    expect(usableLocks({} as Navigator)).toBeUndefined();
    expect(usableLocks({ locks: undefined } as unknown as Navigator)).toBeUndefined();
    expect(usableLocks({ locks: {} } as unknown as Navigator)).toBeUndefined();
  });
});
