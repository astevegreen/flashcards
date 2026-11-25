import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import { readBackupArchive } from '../../packages/core/src/backup/archive.ts';

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

async function readDownloadedBackup(download: Download) {
  expect(download.suggestedFilename()).toMatch(/^flashcards-backup-\d{4}-\d{2}-\d{2}\.flashpkg$/);
  return readBackupArchive(new Uint8Array(readFileSync((await download.path()) ?? '')));
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

    // Reset asks for confirmation first (C6).
    page.once('dialog', (dialog) => void dialog.accept());
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

    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByRole('button', { name: 'Options' }).first().click();
    await page.locator('[data-testid^="archive-deck-btn-"]').first().click();
    await expect(page.locator('[data-testid^="deck-row-"]')).toHaveCount(4);

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await row.getByRole('button', { name: 'Restore…' }).click();
    await expect(confirm).toContainText('Change 1 deck back');
    // Dev mode syncs over the in-browser channel, so the button says where the restore goes.
    await confirm.getByRole('button', { name: 'Restore on all devices' }).click();
    await expect(panel.getByRole('status')).toContainText('Restored the backup');

    await page.getByRole('button', { name: 'Decks' }).first().click();
    await expect(page.locator('[data-testid^="deck-row-"]')).toHaveCount(5);
  });

  test('Export Backup and a snapshot Download save streamed archives that read back', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto('/?device=backupdownload');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect.poll(() => countBackups(page), { timeout: 30_000 }).toBe(1);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();

    // Settings › Local Backup links directly to Decks › Import / Export (Export tab).
    await page.getByTestId('settings-open-import-export-btn').click();
    await expect(page.getByTestId('import-export-tab-export')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const [full] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-collection-btn').click(),
    ]);
    const exported = await readDownloadedBackup(full);
    // The sample decks hold no media, so the file is packed as a daily (media-less) snapshot.
    expect(exported.manifest.reason).toBe('manual');
    expect(exported.manifest.counts.decks).toBe(5);
    await expect(page.getByTestId('library-status')).toContainText(
      'Exported full collection backup',
    );

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    const panel = page.getByTestId('backups-panel');
    const [snapshot] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByTestId('backup-row').getByRole('button', { name: 'Download' }).click(),
    ]);
    const saved = await readDownloadedBackup(snapshot);
    expect(saved.manifest.reason).toBe('auto');
    expect(saved.manifest.counts.decks).toBe(5);
    expect(saved.state.decks.size).toBe(exported.state.decks.size);
    await expect(panel.getByRole('status')).toContainText('Saved.');
  });
});
