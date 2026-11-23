import { expect, test, type Page } from '@playwright/test';

/**
 * Rolling backups: the app takes a dated snapshot on its own shortly after launch, the snapshot
 * survives "Reset Local Device Data", a restore pulls from sync before it plans, and restoring
 * (previewed, then confirmed) brings an archived deck back.
 */

const dbNameFor = (page: Page) => `flashcards-db-${new URL(page.url()).searchParams.get('device')}`;

async function countBackups(page: Page): Promise<number> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      if (!db.objectStoreNames.contains('backups')) return 0;
      return await new Promise<number>((resolve, reject) => {
        const req = db.transaction('backups', 'readonly').objectStore('backups').count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, dbNameFor(page));
}

test.describe('Automatic backups', () => {
  test('takes a daily snapshot on its own, survives a reset, and restores it', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/?device=autobackup');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect.poll(() => countBackups(page), { timeout: 30_000 }).toBe(1);

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    const panel = page.getByTestId('backups-panel');
    const row = panel.getByTestId('backup-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Daily');
    await expect(row).toContainText('5 decks');

    await page.getByRole('button', { name: 'Reset Local Device Data' }).click();
    await expect(page.getByText('Local device storage cleared.')).toBeVisible();
    expect(await countBackups(page)).toBe(1);

    // Dev mode syncs over the in-browser channel: the restore pulls first, which already brings
    // the collection back, so the plan is empty.
    await row.getByRole('button', { name: 'Restore…' }).click();
    const confirm = panel.getByTestId('restore-confirm');
    await expect(confirm).toContainText('Your collection already matches this backup');
    await expect(confirm).toContainText('may survive it');
    await confirm.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByRole('button', { name: 'Options' }).first().click();
    await page.locator('[data-testid^="archive-deck-btn-"]').first().click();
    await expect(page.locator('[data-testid^="deck-row-"]')).toHaveCount(4);

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await row.getByRole('button', { name: 'Restore…' }).click();
    await expect(confirm).toContainText('Change 1 deck back');
    // Dev mode syncs over the in-browser channel, so the button says where the restore goes.
    await confirm.getByRole('button', { name: 'Restore on all devices' }).click();
    await expect(panel.getByRole('status')).toContainText('Restored the backup');

    await page.getByRole('button', { name: 'Library' }).first().click();
    await expect(page.locator('[data-testid^="deck-row-"]')).toHaveCount(5);
  });
});
