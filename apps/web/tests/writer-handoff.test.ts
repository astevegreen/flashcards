import 'fake-indexeddb/auto';
import type { StoredBackupInfo } from '@flash/platform';
import { DexieStorage } from '@flash/platform-web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_MESSAGE,
  TAKE,
  blockWrites,
  resetYieldedForTests,
  takeOver,
  writeBarrier,
  yieldWriter,
} from '../src/writer-handoff.ts';
import { holdWriterLock, waitUpTo } from '../src/writer-lock.ts';
import { fakeLocks } from './helpers/fake-locks.ts';

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

afterEach(() => resetYieldedForTests());

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

function fakeWindow() {
  const listeners: string[] = [];
  const reload = vi.fn();
  const win = {
    addEventListener: (type: string, _l: unknown, capture?: boolean) => {
      if (capture) listeners.push(type);
    },
    location: { reload },
    indexedDB,
  } as unknown as Window;
  return { win, listeners, reload };
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
    const all = methodNames(storage);
    const writes = all.filter((name) => !READS.includes(name));
    // Writes the old name pattern missed are blocked too.
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
  it('lets a started write land, closes the database, then releases and reloads', async () => {
    const slug = freshSlug();
    const storage = new DexieStorage(slug);
    const backups = await storage.openBackupStore();
    const { win, listeners, reload } = fakeWindow();
    const order: string[] = [];
    const release = vi.fn(() => order.push('release'));

    const started = storage.setKv('last', 'from the old writer').then(() => order.push('write'));
    await yieldWriter(storage, storage.dbName, win, release);
    await started;

    expect(order).toEqual(['write', 'release']);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(listeners).toEqual(['pagehide', 'visibilitychange', 'focus', 'online']);
    await expect(storage.setKv('later', 1)).rejects.toThrow(BLOCKED_MESSAGE);
    // A backup store opened before the handoff can no longer write either.
    await expect(backups.put(backupInfo, new Uint8Array([1]))).rejects.toThrow();
    // The next writer sees the old writer's last write.
    expect(await new DexieStorage(slug).getKv('last')).toBe('from the old writer');
  });

  it('runs once per page', async () => {
    const storage = new DexieStorage(freshSlug());
    const { win, reload } = fakeWindow();
    await Promise.all([
      yieldWriter(storage, storage.dbName, win),
      yieldWriter(storage, storage.dbName, win),
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the write barrier resolves for a database that has no stores', async () => {
    await expect(writeBarrier(indexedDB, `empty-${freshSlug()}`)).resolves.toBeUndefined();
  });
});

describe('takeOver', () => {
  it('asks the writer over a BroadcastChannel and gets the lock without stealing', async () => {
    const { locks, stats } = fakeLocks();
    const name = `flashcards-db-${freshSlug()}`;
    const holderLost = vi.fn();
    const release = await holdWriterLock(locks, name, waitUpTo(10), holderLost);
    const holder = new BroadcastChannel(`${name}:writer`);
    holder.onmessage = (e: MessageEvent) => {
      if (e.data === TAKE) release?.();
    };
    try {
      expect(await takeOver(locks, name, vi.fn(), 2000)).toBeTypeOf('function');
      expect(stats.steals).toBe(0);
      expect(holderLost).not.toHaveBeenCalled();
    } finally {
      holder.close();
    }
  });

  it('steals the lock when the writer does not answer in time', async () => {
    const { locks, stats } = fakeLocks();
    const name = `flashcards-db-${freshSlug()}`;
    const holderLost = vi.fn();
    await holdWriterLock(locks, name, waitUpTo(10), holderLost);
    expect(await takeOver(locks, name, vi.fn(), 20)).toBeTypeOf('function');
    expect(stats.steals).toBe(1);
    await vi.waitFor(() => expect(holderLost).toHaveBeenCalledTimes(1));
  });
});
