import { expect, test, type Page } from '@playwright/test';

/**
 * Check collection: Check media finds a stored file nothing uses and removes it after a
 * confirmation; Check database rebuilds the collection from its event log and finds no drift.
 */

const dbNameFor = (page: Page) => `flashcards-db-${new URL(page.url()).searchParams.get('device')}`;
const ORPHAN = 'c'.repeat(64);

async function mediaHashes(page: Page, put?: string): Promise<string[]> {
  return page.evaluate(
    async ({ dbName, hash }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const store = db.transaction('media', 'readwrite').objectStore('media');
        if (hash) store.put({ hash, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
        return await new Promise<string[]>((resolve, reject) => {
          const req = store.getAllKeys();
          req.onsuccess = () => resolve(req.result.map(String));
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    { dbName: dbNameFor(page), hash: put },
  );
}

test.describe('Check collection', () => {
  test('removes an unused media file and finds no database drift', async ({ page }) => {
    await page.goto('/?device=checkcollection');
    await expect(page.getByTestId('study-card')).toBeVisible();
    expect(await mediaHashes(page, ORPHAN)).toContain(ORPHAN);

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    const panel = page.getByTestId('check-panel');
    await panel.getByRole('button', { name: 'Check media' }).click();
    const unused = panel.getByTestId('media-unused');
    await expect(unused).toContainText('1 unused file');
    await unused.getByRole('button', { name: 'Remove unused files…' }).click();
    await panel.getByTestId('media-remove-confirm').getByRole('button', { name: 'Remove' }).click();
    await expect(panel.getByRole('status')).toContainText('Freed 1 file on this device.');
    await expect(panel.getByTestId('media-check-result')).toContainText(
      'Nothing unused or missing.',
    );
    expect(await mediaHashes(page)).not.toContain(ORPHAN);

    await panel.getByRole('button', { name: 'Check database' }).click();
    await expect(panel.getByTestId('database-check-result')).toContainText('No problems found');
  });
});
