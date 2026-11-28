import type { Page } from '@playwright/test';

/** Payloads of the persisted events of one type in the device's IndexedDB event log. */
export async function storedPayloads(page: Page, dbName: string, type: string): Promise<unknown[]> {
  return page.evaluate(
    async ([name, eventType]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise<unknown[]>((resolve, reject) => {
          const req = db
            .transaction('events', 'readonly')
            .objectStore('events')
            .index('type')
            .getAll(eventType);
          req.onsuccess = () =>
            resolve((req.result as Array<{ payload: unknown }>).map((e) => e.payload));
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    [dbName, type] as const,
  );
}
