import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipApkg } from '../../packages/core/src/import/anki/package.ts';
import { ANKI_IMPORT_LIMITS } from '../../packages/core/src/import/anki/types.ts';

/** Counts persisted events of one type in the device's IndexedDB event log. */
async function countStoredEvents(page: Page, dbName: string, type: string): Promise<number> {
  return page.evaluate(
    async ([name, eventType]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise<number>((resolve, reject) => {
          const req = db
            .transaction('events', 'readonly')
            .objectStore('events')
            .index('type')
            .count(eventType);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    [dbName, type] as const,
  );
}

const browseHeading = (page: Page) => page.locator('h1', { hasText: 'Words' });
const row = (page: Page, text: string) =>
  page.locator('[data-testid^="browse-row-"]', { hasText: text });

async function openBrowse(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Words' }).first().click();
  await expect(page.getByTestId('browse-list')).toBeVisible();
}

async function showKoreanDeck(page: Page): Promise<void> {
  await page.getByLabel('Filter by deck').selectOption({ label: 'Korean Core + Hanja' });
  await expect(browseHeading(page)).toContainText('(4)');
}

test.describe('Phase 9 organizing: tag manager, bulk edit, Due today, CSV export', () => {
  test('tag manager renames and merges categories across the collection', async ({ page }) => {
    const device = 'p9tags';
    await page.goto(`/?device=${device}`);
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openBrowse(page);

    await page.getByTestId('open-tag-manager').click();
    const manager = page.getByTestId('tag-manager');
    await expect(manager).toBeVisible();
    await expect(manager.getByTestId('tag-count-daily')).toHaveText('2');
    await expect(manager.getByTestId('tag-count-topik-1')).toHaveText('3');
    await expect(manager.getByTestId('tag-count-topik-2')).toHaveText('1');

    const upsertsBefore = await countStoredEvents(page, `flashcards-db-${device}`, 'NoteUpserted');

    // Rename daily -> 일상 (Hangul category) as one batch of 2 NoteUpserted events.
    await manager.getByTestId('tag-rename-daily').click();
    await manager.getByTestId('tag-rename-input').fill('일상');
    await manager.getByTestId('tag-rename-submit').click();
    await expect(manager.getByTestId('tag-manager-message')).toContainText('on 2 notes');
    await expect(manager.getByTestId('tag-row-daily')).toHaveCount(0);
    await expect(manager.getByTestId('tag-count-일상')).toHaveText('2');
    await expect
      .poll(() => countStoredEvents(page, `flashcards-db-${device}`, 'NoteUpserted'))
      .toBe(upsertsBefore + 2);

    // Merge topik-1 + topik-2 into "topik::all" (a '::' hierarchy).
    await manager.getByTestId('tag-merge-topik-1').check();
    await manager.getByTestId('tag-merge-topik-2').check();
    await manager.getByTestId('tag-manager-merge-input').fill('topik::all');
    await manager.getByTestId('tag-manager-merge-submit').click();
    await expect(manager.getByTestId('tag-manager-message')).toContainText('on 4 notes');
    await expect(manager.getByTestId('tag-row-topik-1')).toHaveCount(0);
    await expect(manager.getByTestId('tag-row-topik-2')).toHaveCount(0);
    await expect(manager.getByTestId('tag-count-topik')).toHaveText('4');
    await expect(manager.getByTestId('tag-count-topik::all')).toHaveText('4');

    // The Browse category filter sees the new names right away.
    await page.getByTestId('browse-category-toggle').click();
    await page.getByTestId('browse-category-option-일상').locator('xpath=..').click();
    await expect(browseHeading(page)).toContainText('(2)');
    await expect(page.getByTestId('browse-list')).toContainText('학교');
    await expect(page.getByTestId('browse-list')).toContainText('약속');
    await page.getByTestId('browse-category-clear').click();

    // Delete with inline confirmation.
    await manager.getByTestId('tag-delete-places').click();
    await manager.getByTestId('tag-delete-confirm-places').click();
    await expect(manager.getByTestId('tag-row-places')).toHaveCount(0);

    // Survives a reload (events replayed on boot).
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openBrowse(page);
    await page.getByTestId('open-tag-manager').click();
    await expect(page.getByTestId('tag-count-일상')).toHaveText('2');
    await expect(page.getByTestId('tag-count-topik::all')).toHaveText('4');
  });

  test('Browse bulk edit: multi-select, add category, suspend, move deck, export CSV', async ({
    page,
  }) => {
    const device = 'p9bulk';
    await page.goto(`/?device=${device}`);
    await expect(page.getByTestId('study-card')).toBeVisible();

    // A second Korean vocabulary deck to move notes into.
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByPlaceholder('Deck name (e.g., TOPIK II Verbs)').fill('Korean Extra');
    await page.getByRole('button', { name: 'Create Deck' }).click();
    await expect(page.getByText('Created deck "Korean Extra".')).toBeVisible();

    await openBrowse(page);
    await showKoreanDeck(page);

    // Select-all-visible toggles every row, then pick two notes.
    await page.getByTestId('browse-select-all').check();
    await expect(page.getByTestId('bulk-selected-count')).toHaveText('4 notes selected');
    await page.getByTestId('browse-select-all').uncheck();
    await expect(page.getByTestId('bulk-edit-bar')).toHaveCount(0);
    await row(page, '학교').locator('[data-testid^="browse-select-"]').check();
    await row(page, '약속').locator('[data-testid^="browse-select-"]').check();
    await expect(page.getByTestId('bulk-selected-count')).toHaveText('2 notes selected');

    // Add a category to both (one batch).
    const upsertsBefore = await countStoredEvents(page, `flashcards-db-${device}`, 'NoteUpserted');
    await page.getByTestId('bulk-add-tags-input').fill('복습');
    await page.getByTestId('bulk-add-tags-submit').click();
    await expect(page.getByTestId('bulk-message')).toContainText('2 notes');
    await expect
      .poll(() => countStoredEvents(page, `flashcards-db-${device}`, 'NoteUpserted'))
      .toBe(upsertsBefore + 2);
    await page.getByTestId('browse-category-toggle').click();
    await expect(page.getByTestId('browse-category-option-복습').locator('xpath=..')).toContainText(
      '2',
    );

    // Suspend both.
    await page.getByTestId('bulk-suspend').click();
    await expect(row(page, '학교').getByTestId('browse-suspended-badge')).toHaveText('Suspended');
    await expect(row(page, '약속').getByTestId('browse-suspended-badge')).toHaveText('Suspended');
    await expect(row(page, '도서관').getByTestId('browse-suspended-badge')).toHaveCount(0);

    // Export the selection as CSV with its categories.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('bulk-export-csv').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const csvPath = await download.path();
    const csv = readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
    const [header, ...lines] = csv.trim().split(/\r?\n/);
    expect(header).toContain('Card ID');
    expect(header).toContain('Category 1');
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.includes('학교'))).toContain('복습');

    // The same selection "For Anki": a zip with the CSV (Anki header lines) and a README.
    await page.getByTestId('bulk-export-for-anki').check();
    const [ankiDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('bulk-export-csv').click(),
    ]);
    expect(ankiDownload.suggestedFilename()).toMatch(/-anki\.zip$/);
    const zipped = unzipApkg(new Uint8Array(readFileSync(await ankiDownload.path())), {
      ...ANKI_IMPORT_LIMITS,
    });
    const csvName = [...zipped.keys()].find((n) => n.endsWith('.csv'));
    expect(zipped.has('README.txt')).toBe(true);
    const ankiCsv = new TextDecoder().decode(zipped.get(csvName ?? '') ?? new Uint8Array());
    const ankiLines = ankiCsv.trim().split('\r\n');
    expect(ankiLines.slice(0, 2)).toEqual(['#separator:Comma', '#html:true']);
    // The note type is a #notetype: header now (#102), so the deck is column 2.
    expect(ankiLines.some((l) => l.startsWith('#notetype:'))).toBe(true);
    expect(ankiLines).toContain('#deck column:2');
    expect(ankiLines.filter((l) => !l.startsWith('#'))).toHaveLength(2);
    expect(ankiLines.find((l) => l.includes('학교'))).toContain('복습');
    await expect(page.getByTestId('bulk-message')).toContainText('-anki.zip');
    await page.getByTestId('bulk-export-for-anki').uncheck();

    // Move both to the new deck.
    await page.getByTestId('bulk-move-deck-select').selectOption({ label: 'Korean Extra' });
    await page.getByTestId('bulk-move-deck-submit').click();
    await expect(browseHeading(page)).toContainText('(2)');
    await expect(row(page, '학교')).toHaveCount(0);
    await page.getByLabel('Filter by deck').selectOption({ label: 'Korean Extra' });
    await expect(browseHeading(page)).toContainText('(2)');
    await expect(row(page, '학교')).toBeVisible();
    // Suspension follows the cards (same card ids in the new deck).
    await expect(row(page, '학교').getByTestId('browse-suspended-badge')).toHaveText('Suspended');
  });

  test('Browse "Due today" leaves suspended cards out', async ({ page }) => {
    await page.goto('/?device=p9due');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('count-new')).toHaveText('4');

    // Rate the first card Again: it is learning and due again within minutes (= due today).
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await page.keyboard.press('1');
    await expect(page.getByTestId('count-new')).toHaveText('3');

    await openBrowse(page);
    await showKoreanDeck(page);
    await page.getByTestId('browse-state-filter').selectOption('due');
    await expect(browseHeading(page)).toContainText('(1)');

    const dueRow = page.locator('[data-testid^="browse-row-"]').first();
    await dueRow.locator('[data-testid^="browse-suspend-note-"]').click();
    await expect(browseHeading(page)).toContainText('(0)');

    await page.getByTestId('browse-state-filter').selectOption('suspended');
    await expect(browseHeading(page)).toContainText('(1)');
  });
});
