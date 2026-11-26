import 'fake-indexeddb/auto';
import type { StoredBackupInfo } from '@flash/platform';
import { DexieStorage } from '@flash/platform-web';
import { describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_MESSAGE,
  blockWrites,
  takeOver,
  writeBarrier,
  yieldWriter,
} from '../src/writer-handoff.ts';
import { holdWriterLock, waitUpTo, type WriterMessage } from '../src/writer-lock.ts';
import { fakeLocks } from './helpers/fake-locks.ts';
import { fakeWindow } from './helpers/fake-window.ts';

const READS = [
  'getAllEvents',
  'getDeviceEventsAfterSeq',
  'getEventsAfterLocalSeq',
  'getMaxLocalSeq',
  'getDeviceMeta',
  'getSyncCursor',
  'getSyncConfig',
  'getLocalSnapshot',
  'getKv',
  'getMedia',
  'listMediaHashes',
];

let slugCount = 0;
const freshSlug = () => `handoff${++slugCount}`;

/** Every method of a storage instance and its prototype chain. */
function methodNames(storage: object): string[] {
  const names = new Set<string>();
  for (let p: object | null = storage; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const key of Object.getOwnPropertyNames(p)) {
      if (
        key !== 'constructor' &&
        typeof (storage as Record<string, unknown>)[key] === 'function'
      ) {
        names.add(key);
      }
    }
  }
  return [...names];
}

const backupInfo: StoredBackupInfo = {
  format_version: 1,
  backup_id: 'b1',
  kind: 'daily',
  reason: 'auto',
  created_at: 1,
  device_id: 'device-x',
  total_events: 0,
  counts: { decks: 0, notes: 0, cards: 0, reviews: 0, media: 0 },
  media_hashes: [],
  media_included: false,
  size_bytes: 1,
};

describe('blockWrites', () => {
  it('blocks every DexieStorage method but the known reads (fail closed)', async () => {
    const storage = new DexieStorage(freshSlug());
    await storage.setKv('k', 'before');
    const writes = methodNames(storage).filter((name) => !READS.includes(name));
    // Writes a name pattern would miss are blocked too.
    expect(writes).toEqual(
      expect.arrayContaining([
        'appendEvents',
        'appendEventsWithMeta',
        'setDeviceMeta',
        'ensureDeviceMeta',
        'requestPersistence',
        'openBackupStore',
        'clearAll',
      ]),
    );

    blockWrites(storage);

    const target = storage as unknown as Record<string, () => Promise<unknown>>;
    for (const name of writes) {
      await expect(target[name]?.(), name).rejects.toThrow(BLOCKED_MESSAGE);
    }
    expect(await storage.getKv('k')).toBe('before');
    expect(await storage.getAllEvents()).toEqual([]);
  });

  it('blocks own-property methods of a wrapped or adapter storage', async () => {
    const write = vi.fn(async () => undefined);
    const adapter = { getKv: async () => 'read', saveEverything: write, setKv: write };
    blockWrites(adapter);
    await expect(adapter.saveEverything()).rejects.toThrow(BLOCKED_MESSAGE);
    await expect(adapter.setKv()).rejects.toThrow(BLOCKED_MESSAGE);
    expect(await adapter.getKv()).toBe('read');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('yieldWriter', () => {
  it('saves queued writes and lets started ones land, then closes, releases and reloads', async () => {
    const slug = freshSlug();
    const storage = new DexieStorage(slug);
    const backups = await storage.openBackupStore();
    const { win, listeners, reload } = fakeWindow();
    const order: string[] = [];
    const release = vi.fn(() => order.push('release'));
    // The app's persist queue: a rating already shown, still being saved.
    const queued = storage.setKv('rating', 'shown').then(() => order.push('queued write'));
    const whenSaved = () => queued.then(() => undefined);
    const started = storage.setKv('last', 'started').then(() => order.push('started write'));

    await yieldWriter(storage, storage.dbName, win, release, whenSaved);
    await started;

    expect(order.indexOf('queued write')).toBeLessThan(order.indexOf('release'));
    expect(order.indexOf('started write')).toBeLessThan(order.indexOf('release'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(listeners).toEqual(['pagehide', 'visibilitychange', 'focus', 'online']);
    // A new edit after the handoff began is blocked.
    await expect(storage.setKv('later', 1)).rejects.toThrow(BLOCKED_MESSAGE);
    // A backup store opened before the handoff can no longer write either.
    await expect(backups.put(backupInfo, new Uint8Array([1]))).rejects.toThrow();
    // The next writer sees both writes.
    const next = new DexieStorage(slug);
    expect(await next.getKv('rating')).toBe('shown');
    expect(await next.getKv('last')).toBe('started');
  });

  it('still hands over when a queued write failed', async () => {
    const storage = new DexieStorage(freshSlug());
    const { win, reload } = fakeWindow();
    const release = vi.fn();
    await yieldWriter(storage, storage.dbName, win, release, () =>
      Promise.reject(new Error('1 change(s) could not be saved.')),
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('runs once per storage', async () => {
    const storage = new DexieStorage(freshSlug());
    const { win, reload } = fakeWindow();
    await Promise.all([
      yieldWriter(storage, storage.dbName, win, vi.fn()),
      yieldWriter(storage, storage.dbName, win, vi.fn()),
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the write barrier resolves for a database that has no stores', async () => {
    await expect(writeBarrier(indexedDB, `empty-${freshSlug()}`)).resolves.toBeUndefined();
  });
});

describe('takeOver', () => {
  it('keeps asking until the waiting request wins, without stealing', async () => {
    const { locks, stats } = fakeLocks();
    const name = `flashcards-db-${freshSlug()}`;
    const holderLost = vi.fn();
    const release = await holdWriterLock(locks, name, waitUpTo(10), holderLost);
    const won = new AbortController();
    const queued = new AbortController();
    void holdWriterLock(locks, name, { signal: queued.signal }, vi.fn()).then(
      (r) => r && won.abort(),
    );
    // The writer misses the first request, then hands over on the next one.
    const holder = new BroadcastChannel(`${name}:writer`);
    let asks = 0;
    holder.onmessage = (e: MessageEvent<WriterMessage>) => {
      if ('take' in e.data && ++asks === 2) release?.();
    };
    try {
      expect(await takeOver(locks, name, 'me', vi.fn(), won.signal, queued, 2000)).toBeNull();
      expect(won.signal.aborted).toBe(true);
      expect(stats.steals).toBe(0);
      expect(holderLost).not.toHaveBeenCalled();
    } finally {
      holder.close();
    }
  });

  it('keeps waiting while the writer says it is still handing over', async () => {
    const { locks, stats } = fakeLocks();
    const name = `flashcards-db-${freshSlug()}`;
    const release = await holdWriterLock(locks, name, waitUpTo(10), vi.fn());
    const won = new AbortController();
    const queued = new AbortController();
    void holdWriterLock(locks, name, { signal: queued.signal }, vi.fn()).then(
      (r) => r && won.abort(),
    );
    // A long save: the writer answers "yielding" for several rounds before it releases.
    const holder = new BroadcastChannel(`${name}:writer`);
    const yielding: WriterMessage = { yielding: true };
    const beat = setInterval(() => holder.postMessage(yielding), 10);
    setTimeout(() => release?.(), 200);
    try {
      expect(await takeOver(locks, name, 'me', vi.fn(), won.signal, queued, 50)).toBeNull();
      expect(stats.steals).toBe(0);
    } finally {
      clearInterval(beat);
      holder.close();
    }
  });

  it('steals the lock when the writer does not answer in time', async () => {
    const { locks, stats } = fakeLocks();
    const name = `flashcards-db-${freshSlug()}`;
    const holderLost = vi.fn();
    await holdWriterLock(locks, name, waitUpTo(10), holderLost);
    const won = new AbortController();
    const queued = new AbortController();
    const waiting = holdWriterLock(locks, name, { signal: queued.signal }, vi.fn());
    expect(await takeOver(locks, name, 'me', vi.fn(), won.signal, queued, 20)).toBeTypeOf(
      'function',
    );
    expect(stats.steals).toBe(1);
    expect(queued.signal.aborted).toBe(true);
    expect(await waiting).toBeNull();
    await vi.waitFor(() => expect(holderLost).toHaveBeenCalledTimes(1));
  });
});
