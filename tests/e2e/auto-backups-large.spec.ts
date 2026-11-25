import { expect, test, type Page } from '@playwright/test';
import { PRODUCTION_CSP } from '../../apps/web/csp.ts';

/**
 * A snapshot whose `backup/state.json` is far over 160 KB, under the production CSP (sent as a
 * header too). fflate's async zip compresses entries that size in a `blob:` worker, which
 * `worker-src 'self'` refuses: every snapshot, and the one a restore takes first, failed or hung.
 */

const dbNameFor = (page: Page) => `flashcards-db-${new URL(page.url()).searchParams.get('device')}`;

const REVIEWS_PER_CARD = 80;

/** Writes a long review history for every card straight into the event log; returns the count. */
async function seedReviews(page: Page): Promise<number> {
  return page.evaluate(
    async ({ dbName, perCard }) => {
      const DAY = 86_400_000;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const getAll = (store: string) =>
        new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(store, 'readonly').objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const cards = ((await getAll('cards_cache')) as { id: string }[]).map((c) => c.id).sort();
      const kv = (await getAll('kv')) as { key: string; value: unknown }[];
      const counterRow = kv.find((r) => r.key === '__local_seq_counter');
      let localSeq = typeof counterRow?.value === 'number' ? counterRow.value : 0;
      const device = 'seed-large';
      const start = Date.now() - 400 * DAY;
      const rows: unknown[] = [];
      let seq = 0;
      cards.forEach((cardId, c) => {
        for (let i = 0; i < perCard; i++) {
          seq += 1;
          localSeq += 1;
          const at = start + i * 4 * 3_600_000 + c * 60_000;
          const hlcCounter = (seq & 0xffff).toString(16).padStart(4, '0');
          rows.push({
            id: `seed-large-${seq}`,
            device,
            seq,
            hlc: `${at.toString(16).padStart(12, '0')}-${hlcCounter}-${device}`,
            type: 'ReviewRecorded',
            v: 1,
            card_id: cardId,
            local_seq: localSeq,
            payload: {
              review_id: `seed-large-${seq}`,
              card_id: cardId,
              rating: 3,
              reviewed_at: at,
              tz_offset: 0,
              duration_ms: 2000,
              answer_mode: 'flip',
              fsrs_params_version: 0,
              resulting_due_at: at + 3 * DAY,
            },
          });
        }
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['events', 'kv'], 'readwrite');
        const events = tx.objectStore('events');
        for (const row of rows) events.put(row);
        tx.objectStore('kv').put({ key: '__local_seq_counter', value: localSeq });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return rows.length;
    },
    { dbName: dbNameFor(page), perCard: REVIEWS_PER_CARD },
  );
}

test.describe('Automatic backups of a large collection under the production CSP', () => {
  test.use({ serviceWorkers: 'block' });

  test('backs up and restores (with its pre-restore snapshot) without a blob worker', async ({
    page,
    context,
  }) => {
    test.setTimeout(150_000);
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        await route.abort('blockedbyclient');
        return;
      }
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': PRODUCTION_CSP },
      });
    });
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (/Content Security Policy|blob:/i.test(msg.text())) violations.push(msg.text());
    });

    await page.goto('/?device=largebackup');
    await expect(page.getByTestId('study-card')).toBeVisible();
    // About 250 bytes of state.json per review: well over 160 KB.
    expect(await seedReviews(page)).toBeGreaterThanOrEqual(1000);
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    const panel = page.getByTestId('backups-panel');
    const rows = panel.getByTestId('backup-row');
    await panel.getByRole('button', { name: 'Back up now' }).click();
    await expect(panel.getByRole('status')).toContainText('Backup saved', { timeout: 30_000 });
    await expect(rows.filter({ hasText: 'Manual' })).toHaveCount(1);
    await expect(panel.getByTestId('backup-last-error')).toHaveCount(0);

    // A change for the restore to undo.
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByRole('button', { name: 'Options' }).first().click();
    await page.locator('[data-testid^="archive-deck-btn-"]').first().click();
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();

    await rows.filter({ hasText: 'Manual' }).getByRole('button', { name: 'Restore…' }).click();
    const confirm = panel.getByTestId('restore-confirm');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: /^Restore/ }).click();
    await expect(panel.getByRole('status')).toContainText('Restored the backup', {
      timeout: 30_000,
    });
    await expect(rows.filter({ hasText: 'Before a restore' })).toHaveCount(1);
    await expect(panel.getByTestId('backup-last-error')).toHaveCount(0);
    expect(violations).toEqual([]);
  });
});
