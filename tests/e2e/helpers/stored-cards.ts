import type { Page } from '@playwright/test';
import { compareCodeUnits } from '../../../packages/core/src/compare.ts';
import { replayAllEvents } from '../../../packages/core/src/events/replay.ts';
import type { FlashEvent } from '../../../packages/core/src/events/types.ts';

/**
 * The cards the page's stored event log replays to, sorted by id. The app keeps no card table
 * (review P5: boot reads the local snapshot plus newer events), so the log is replayed here.
 */
export async function readStoredCards(
  page: Page,
  dbName: string,
): Promise<{ id: string; deck_id: string }[]> {
  const rows = (await page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction('events', 'readonly').objectStore('events').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, dbName)) as (FlashEvent & { card_id?: string; local_seq?: number })[];
  // The storage-only columns off, in log (hlc) order, as `DexieStorage.getAllEvents` returns them.
  const events = rows
    .map(({ card_id: _c, local_seq: _l, ...event }) => event as FlashEvent)
    .sort((a, b) => compareCodeUnits(a.hlc, b.hlc));
  return [...replayAllEvents(events).cards.values()]
    .map((c) => ({ id: c.id, deck_id: c.deck_id }))
    .sort((a, b) => compareCodeUnits(a.id, b.id));
}
