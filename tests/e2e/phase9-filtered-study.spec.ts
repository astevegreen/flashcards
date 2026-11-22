import { expect, test, type Page } from '@playwright/test';

/** Clicks the visually hidden category checkbox through its pill label. */
async function toggleCategory(page: Page, prefix: string, tag: string): Promise<void> {
  await page.getByTestId(`${prefix}-option-${tag}`).locator('xpath=..').click();
}

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

const browseHeading = (page: Page) => page.locator('h1', { hasText: 'Browse' });

async function openBrowse(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Browse' }).first().click();
  await expect(page.getByTestId('browse-list')).toBeVisible();
}

async function openStudy(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Study' }).first().click();
  await expect(page.getByLabel('Select deck to study')).toBeVisible();
}

test.describe('Phase 9 categories, filtered study and suspend', () => {
  test('Browse multi-select category filter (any / all / none) and suspend / unsuspend', async ({
    page,
  }) => {
    await page.goto('/?device=p9browse');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('count-new')).toHaveText('4');

    await openBrowse(page);
    const list = page.getByTestId('browse-list');
    await page.getByLabel('Filter by deck').selectOption({ label: 'Korean Core + Hanja' });
    await expect(browseHeading(page)).toContainText('(4)');

    await page.getByTestId('browse-category-toggle').click();
    await expect(page.getByTestId('browse-category-panel')).toBeVisible();

    // any: #topik-2 -> only 경험
    await toggleCategory(page, 'browse-category', 'topik-2');
    await expect(list).toContainText('경험');
    await expect(list).not.toContainText('학교');
    await expect(browseHeading(page)).toContainText('(1)');

    // none: everything except #topik-2
    await page.getByTestId('browse-category-mode-none').click();
    await expect(browseHeading(page)).toContainText('(3)');
    await expect(list).toContainText('학교');
    await expect(list).not.toContainText('경험');

    // all: #topik-1 AND #daily -> 학교, 약속 (not 도서관)
    await toggleCategory(page, 'browse-category', 'topik-2');
    await page.getByTestId('browse-category-mode-all').click();
    await toggleCategory(page, 'browse-category', 'topik-1');
    await toggleCategory(page, 'browse-category', 'daily');
    await expect(browseHeading(page)).toContainText('(2)');
    await expect(list).toContainText('학교');
    await expect(list).toContainText('약속');
    await expect(list).not.toContainText('도서관');

    // The #tag text shortcut still works on top of the picker.
    await page.getByTestId('browse-category-clear').click();
    await page.getByLabel('Search notes by text or tag').fill('#places');
    await expect(browseHeading(page)).toContainText('(1)');
    await expect(list).toContainText('도서관');
    await page.getByLabel('Search notes by text or tag').fill('');

    // Suspend 경험 (CardSuspended event) and find it with the Suspended state filter.
    const row = page.locator('[data-testid^="browse-row-"]', { hasText: '경험' });
    await row.locator('[data-testid^="browse-suspend-note-"]').click();
    await expect(row.getByTestId('browse-suspended-badge')).toHaveText('Suspended');
    await page.getByTestId('browse-state-filter').selectOption('suspended');
    await expect(browseHeading(page)).toContainText('(1)');
    await expect(list).toContainText('경험');

    // Suspended cards leave the study queue.
    await openStudy(page);
    await expect(page.getByTestId('count-new')).toHaveText('3');

    // Unsuspend restores it.
    await openBrowse(page);
    await page.getByLabel('Filter by deck').selectOption({ label: 'Korean Core + Hanja' });
    const row2 = page.locator('[data-testid^="browse-row-"]', { hasText: '경험' });
    await expect(row2.locator('[data-testid^="browse-suspend-note-"]')).toHaveText('Unsuspend');
    await row2.locator('[data-testid^="browse-suspend-note-"]').click();
    await expect(row2.getByTestId('browse-suspended-badge')).toHaveCount(0);
    await openStudy(page);
    await expect(page.getByTestId('count-new')).toHaveText('4');

    // Suspension survives a reload (persisted events, replayed on boot).
    await openBrowse(page);
    await page.getByLabel('Filter by deck').selectOption({ label: 'Korean Core + Hanja' });
    const row3 = page.locator('[data-testid^="browse-row-"]', { hasText: '약속' });
    await row3.locator('[data-testid^="browse-suspend-note-"]').click();
    await expect(row3.getByTestId('browse-suspended-badge')).toHaveText('Suspended');
    // Wait until the async persistence queue has written the events to IndexedDB.
    await expect
      .poll(() => countStoredEvents(page, 'flashcards-db-p9browse', 'CardSuspended'))
      .toBe(2);
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('count-new')).toHaveText('3');
  });

  test('Study this filter: Browse categories, Failed this week and Trouble cards presets', async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto('/?device=p9study');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('count-new')).toHaveText('4');

    // Fail the first Korean card (학교) -> Again.
    await expect(page.getByTestId('study-card')).toContainText('학교');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await page.keyboard.press('1');
    await expect(page.getByTestId('count-new')).toHaveText('3');

    // Presets count the failed card; it is not due yet (short-term learning step).
    await page.getByTestId('study-filter-btn').click();
    await expect(page.getByTestId('study-filter-panel')).toBeVisible();
    await expect(page.getByTestId('study-filter-scope')).toHaveText('Korean Core + Hanja');
    await expect(page.getByTestId('study-filter-count-failed-this-week')).toHaveText(
      '0 due · 1 cards',
    );
    await expect(page.getByTestId('study-filter-count-trouble-cards')).toHaveText(
      '0 due · 1 cards',
    );

    await page.getByTestId('study-filter-start-failed-this-week').click();
    await expect(page.getByTestId('study-filter-chip')).toContainText('Failed this week');
    await expect(page.getByTestId('count-new')).toHaveText('0');
    await expect(page.getByText('Learning card coming up')).toBeVisible();

    // Same FSRS schedule: once the learning step elapses the card appears in the filtered session.
    await page.clock.fastForward('05:00');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect(page.getByTestId('study-card')).toContainText('학교');
    await expect(page.getByTestId('count-learning')).toHaveText('1');
    await expect(page.getByTestId('count-new')).toHaveText('0');

    // Clearing the filter returns to the normal queue.
    await page.getByTestId('study-filter-clear').click();
    await expect(page.getByTestId('study-filter-chip')).toHaveCount(0);
    await expect(page.getByTestId('count-new')).toHaveText('3');

    // Trouble cards: hardest missed cards across the chosen deck.
    await page.getByTestId('study-filter-btn').click();
    await expect(page.getByTestId('study-filter-count-trouble-cards')).toHaveText(
      '1 due · 1 cards',
    );
    await page.getByTestId('study-filter-start-trouble-cards').click();
    await expect(page.getByTestId('study-filter-chip')).toContainText('Trouble cards');
    await expect(page.getByTestId('study-card')).toContainText('학교');
    await page.getByTestId('study-filter-clear').click();

    // Browse category selection becomes "Study this filter" in Study.
    await openBrowse(page);
    await page.getByTestId('browse-category-toggle').click();
    await toggleCategory(page, 'browse-category', 'places');
    await expect(page.getByTestId('browse-list')).toContainText('도서관');
    await openStudy(page);
    await page.getByLabel('Select deck to study').selectOption({ label: 'All Decks' });
    await page.getByTestId('study-filter-btn').click();
    await expect(page.getByTestId('study-filter-category-option-places')).toBeChecked();
    await expect(page.getByTestId('study-filter-count-custom')).toHaveText('1 due · 1 cards');
    await page.getByTestId('study-filter-start-custom').click();
    await expect(page.getByTestId('study-filter-chip')).toContainText('Study this filter');
    await expect(page.getByTestId('study-card')).toContainText('도서관');
    await expect(page.getByTestId('count-new')).toHaveText('1');
  });
});
