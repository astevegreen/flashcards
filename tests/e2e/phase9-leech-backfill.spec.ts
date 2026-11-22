import { expect, test, type Page } from '@playwright/test';
import {
  deriveCardId,
  deriveNoteId,
  FLASH_NAMESPACE_UUID,
  uuidv5,
} from '../../packages/core/src/index.ts';

/**
 * Leech backfill: a card that already has 8+ lapses from before leech tagging existed (here: a
 * review history written straight into the event log, as an older build would have left it) gets
 * its note tagged `leech` once the app has synced, as one set-union `NoteTagsAdded` event, and a
 * second launch adds nothing more.
 */

const KO_DECK = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
const KO_NOTE = deriveNoteId(KO_DECK, 'ko-1');
const KO_CARD = deriveCardId(KO_NOTE, 'layout:vocab-ko:recognition', 0);
const dbNameFor = (page: Page) => `flashcards-db-${new URL(page.url()).searchParams.get('device')}`;

interface EventRow {
  type: string;
  payload: Record<string, unknown>;
}

async function readEvents(page: Page): Promise<EventRow[]> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<EventRow[]>((resolve, reject) => {
        const req = db.transaction('events', 'readonly').objectStore('events').getAll();
        req.onsuccess = () => resolve(req.result as EventRow[]);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, dbNameFor(page));
}

/** The stored sync cursor's `lastSyncedAt`, read straight from IndexedDB. */
async function readSyncedAt(page: Page): Promise<number | null> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<number | null>((resolve, reject) => {
        const req = db.transaction('kv', 'readonly').objectStore('kv').get('sync_cursor');
        req.onsuccess = () => {
          const row = req.result as { value?: { lastSyncedAt?: number } } | undefined;
          resolve(row?.value?.lastSyncedAt ?? null);
        };
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, dbNameFor(page));
}

/** Writes a legacy history for `cardId`: graduated, then `lapses` x (Again, Good, Good). */
async function seedLegacyLapses(page: Page, cardId: string, lapses: number): Promise<void> {
  await page.evaluate(
    async ({ dbName, card, count }) => {
      const DAY = 86_400_000;
      const MIN = 60_000;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const kvRows = await new Promise<{ key: string; value: unknown }[]>((resolve, reject) => {
        const req = db.transaction('kv', 'readonly').objectStore('kv').getAll();
        req.onsuccess = () => resolve(req.result as { key: string; value: unknown }[]);
        req.onerror = () => reject(req.error);
      });
      const counter = kvRows.find((r) => r.key === '__local_seq_counter')?.value;
      let localSeq = typeof counter === 'number' ? counter : 0;
      const ratings = [3, 3];
      for (let i = 0; i < count; i++) ratings.push(1, 3, 3);
      let at = Date.now() - 200 * DAY;
      const device = 'legacy-device';
      const rows = ratings.map((rating, i) => {
        at += rating === 1 ? 3 * DAY : 10 * MIN;
        localSeq += 1;
        const seq = i + 1;
        return {
          id: `legacy-review-${seq}`,
          device,
          seq,
          hlc: `${at.toString(16).padStart(12, '0')}-${seq.toString(16).padStart(4, '0')}-${device}`,
          type: 'ReviewRecorded',
          v: 1,
          card_id: card,
          local_seq: localSeq,
          payload: {
            review_id: `legacy-review-${seq}`,
            card_id: card,
            rating,
            reviewed_at: at,
            tz_offset: 0,
            duration_ms: 1500,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: at + DAY,
          },
        };
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['events', 'kv'], 'readwrite');
        for (const row of rows) tx.objectStore('events').put(row);
        tx.objectStore('kv').put({ key: '__local_seq_counter', value: localSeq });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: dbNameFor(page), card: cardId, count: lapses },
  );
}

async function syncNow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByTestId('sync-now-btn').click();
  await expect(page.getByTestId('sync-status-pill')).toHaveText('Synced');
}

const backfills = (events: EventRow[]) =>
  events.filter((e) => e.type === 'NoteTagsAdded' && e.payload['reason'] === 'leech-backfill');

test.describe('Phase 9 leech backfill', () => {
  test('tags an existing 8-lapse leech once, after the first sync of the launch', async ({
    page,
  }) => {
    await page.goto('/?device=leechfill');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await seedLegacyLapses(page, KO_CARD, 8);
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();

    await syncNow(page);
    await expect.poll(async () => backfills(await readEvents(page)).length).toBe(1);
    const [event] = backfills(await readEvents(page));
    expect(event?.payload).toEqual({ note_id: KO_NOTE, tags: ['leech'], reason: 'leech-backfill' });

    // Next launch: already tagged, nothing more is written.
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await syncNow(page);
    // Persistence is one serial queue. A backfill planned after that sync is queued before the
    // cursor write of the NEXT sync, so once that cursor is on disk any second backfill would be.
    const cursorBefore = await readSyncedAt(page);
    await page.getByTestId('sync-now-btn').click();
    await expect.poll(() => readSyncedAt(page)).not.toBe(cursorBefore);
    expect(backfills(await readEvents(page))).toHaveLength(1);
  });
});
