import { expect, test } from '@playwright/test';
import {
  FakeDropboxServer,
  installDropboxFakes,
  type DropboxFakes,
} from './helpers/dropbox-fakes.ts';

test.describe('Dropbox App Folder linked sources (fake Dropbox)', () => {
  test('connects Dropbox from Linked Sources, hides sync folders, imports and links CSV, refreshes, and unlinks', async ({
    browser,
  }) => {
    const enc = new TextEncoder();
    const fakes: DropboxFakes = { server: new FakeDropboxServer(), exchanges: [] };
    // Sync data folders at App Folder root must never appear in the file picker.
    fakes.server.put('sync/v1/manifest.json', enc.encode('{}'), 1);
    fakes.server.put('media/aa/deadbeef.png', new Uint8Array([1, 2, 3]), 1);
    // User spreadsheets inside Dropbox/Apps/Flashcards/
    fakes.server.put(
      'Decks/Dropbox Animals.csv',
      enc.encode('word,meaning\n고양이,cat\n강아지,puppy\n'),
      1,
    );
    fakes.server.put('Decks/notes.txt', enc.encode('ignored'), 1);

    const context = await browser.newContext();
    await installDropboxFakes(context, fakes, () => 'device=dbxsrc');
    const page = await context.newPage();
    await page.goto('/?device=dbxsrc');
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByTestId('dropbox-import-btn').click();
    await page.getByTestId('dropbox-connect-btn').click();

    // Back from OAuth: connecting from Sources does not turn on Dropbox Sync.
    await expect(page.getByTestId('study-card')).toBeVisible();
    expect(fakes.exchanges[0]?.scope).toContain('files.content.read');
    expect(fakes.exchanges[0]?.scope).toContain('files.metadata.read');
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('connect-dropbox-btn')).toBeVisible();

    // Browse App Folder: sync/ and media/ are hidden; Decks/ is visible.
    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByTestId('dropbox-import-btn').click();
    await expect(page.getByTestId('dropbox-folder-sync')).toHaveCount(0);
    await expect(page.getByTestId('dropbox-folder-media')).toHaveCount(0);
    await page.getByTestId('dropbox-folder-Decks').click();
    await expect(page.getByTestId('dropbox-file-notes.txt')).toHaveCount(0);

    // Link Dropbox Animals.csv with column mapping.
    await page.getByTestId('dropbox-link-Dropbox Animals.csv').click();
    await expect(page.getByTestId('dropbox-link-mapping')).toBeVisible();
    await page.getByTestId('dropbox-link-confirm-btn').click();
    await expect(page.getByText('Linked "Dropbox Animals.csv" from Dropbox')).toBeVisible();

    const linkedId = fakes.server.findByIdOrPath('/Decks/Dropbox Animals.csv')?.id ?? '';
    const row = page.getByTestId(`dropbox-source-row-${linkedId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Synced');

    // File updates in Dropbox -> Refresh pulls the new row.
    fakes.server.put(
      'Decks/Dropbox Animals.csv',
      enc.encode('word,meaning\n고양이,cat\n강아지,puppy\n토끼,rabbit\n'),
      2,
    );
    await row.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('Refreshed "Dropbox Animals" (1 note change(s))')).toBeVisible();

    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Dropbox Animals' });
    await expect(page.getByTestId('count-new')).toHaveText('3');

    // Unlink removes the source row while keeping the deck intact.
    await page.getByRole('button', { name: 'Library' }).first().click();
    await row.getByRole('button', { name: 'Unlink' }).click();
    await expect(page.getByText('Source unlinked.')).toBeVisible();
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Dropbox Animals' });
    await expect(page.getByTestId('count-new')).toHaveText('3');

    await context.close();
  });
});
