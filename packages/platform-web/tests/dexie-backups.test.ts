import 'fake-indexeddb/auto';
import type { StoredBackupInfo } from '@flash/platform';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieStorage } from '../src/storage/dexie-storage.ts';

const created: string[] = [];

afterEach(async () => {
  for (const name of created.splice(0)) await Dexie.delete(name);
});

function info(id: string, createdAt: number): StoredBackupInfo {
  return {
    format_version: 1,
    backup_id: id,
    kind: 'daily',
    reason: 'auto',
    created_at: createdAt,
    device_id: 'dev-a',
    total_events: 3,
    counts: { decks: 1, notes: 2, cards: 2, reviews: 0, media: 0 },
    media_hashes: [],
    media_included: false,
    size_bytes: 3,
  };
}

describe('DexieStorage rolling backups', () => {
  it('lists newest first, reads, deletes, and keeps backups across clearAll', async () => {
    const storage = new DexieStorage(`backups-${Date.now()}`);
    created.push(storage.dbName);
    const store = await storage.openBackupStore();
    await store.put(info('old', 1), new Uint8Array([1, 2, 3]));
    await store.put(info('new', 2), new Uint8Array([4, 5, 6]));
    expect((await store.list()).map((b) => b.backup_id)).toEqual(['new', 'old']);
    expect([...((await store.getBytes('old')) ?? [])]).toEqual([1, 2, 3]);

    await storage.clearAll();
    expect((await store.list()).map((b) => b.backup_id)).toEqual(['new', 'old']);

    await store.delete('old');
    expect((await store.list()).map((b) => b.backup_id)).toEqual(['new']);
    expect(await store.getBytes('old')).toBeUndefined();
    storage.close();
  });

  it('keeps the media a kept backup lists across clearAll, and only that', async () => {
    const storage = new DexieStorage(`backups-media-${Date.now()}`);
    created.push(storage.dbName);
    const kept = 'a'.repeat(64);
    const dropped = 'b'.repeat(64);
    for (const hash of [kept, dropped]) {
      await storage.putMedia({ hash, mime: 'image/png', bytes: new Uint8Array([1]) });
    }
    const store = await storage.openBackupStore();
    await store.put({ ...info('daily', 1), media_hashes: [kept] }, new Uint8Array([1]));
    await storage.clearAll();
    expect(await storage.listMediaHashes()).toEqual([kept]);

    await store.delete('daily');
    await storage.clearAll();
    expect(await storage.listMediaHashes()).toEqual([]);
    storage.close();
  });

  it('opens a v2 database and adds the backup tables', async () => {
    const slug = `backups-upgrade-${Date.now()}`;
    const v2 = new Dexie(`flashcards-db-${slug}`);
    created.push(v2.name);
    v2.version(2).stores({
      events: 'id, [device+seq], hlc, type, card_id, local_seq',
      cards_cache: 'id, deck_id, due',
      meta: 'key',
      media: 'hash',
      snapshots: 'key',
      kv: 'key',
    });
    await v2.open();
    await v2.table('kv').put({ key: 'kept', value: 1 });
    v2.close();

    const storage = new DexieStorage(slug);
    expect(await storage.getKv('kept')).toBe(1);
    const store = await storage.openBackupStore();
    await store.put(info('a', 1), new Uint8Array([9]));
    expect(await store.list()).toHaveLength(1);
    storage.close();
  });
});
