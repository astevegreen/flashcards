import type { BackupStore, StoredBackupInfo } from '@flash/platform';
import type { Table } from 'dexie';
import type { FlashcardsDexieDb } from './dexie-storage.ts';

interface StoredBackupBlobRow {
  id: string;
  bytes: Uint8Array;
}

/**
 * Rolling backups in IndexedDB (schema version 3): `backups` holds the manifests, `backup_blobs`
 * the archives, so listing never loads an archive. `clearAll` leaves both tables alone.
 * Loaded on demand so the initial study-screen bundle stays lean (§8).
 */
export function createDexieBackupStore(db: FlashcardsDexieDb): BackupStore {
  const infos: Table<StoredBackupInfo, string> = db.table('backups');
  const blobs: Table<StoredBackupBlobRow, string> = db.table('backup_blobs');
  return {
    measuredByStorageEstimate: true,
    list: () => infos.orderBy('created_at').reverse().toArray(),
    put: async (info, bytes) => {
      await db.transaction('rw', [infos, blobs], async () => {
        await blobs.put({ id: info.backup_id, bytes });
        await infos.put(info);
      });
    },
    getBytes: async (backupId) => (await blobs.get(backupId))?.bytes,
    delete: async (backupId) => {
      await db.transaction('rw', [infos, blobs], async () => {
        await infos.delete(backupId);
        await blobs.delete(backupId);
      });
    },
  };
}
