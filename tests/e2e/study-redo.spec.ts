import { expect, test, type Page } from '@playwright/test';

/** Redo after Undo in Study: the undone review comes back, and a new answer ends the redo history. */

/** How many `ReviewRecorded` events the device's database holds (undone ones included). */
async function countStoredReviews(page: Page, dbName: string): Promise<number> {
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('open failed'));
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const req = db
          .transaction('events', 'readonly')
          .objectStore('events')
          .index('type')
          .count('ReviewRecorded');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('count failed'));
      });
    } finally {
      db.close();
    }
  }, dbName);
}

/**
 * Reveals the first card of a freshly loaded page by its button. Study starts listening for keys in
 * an effect just after the first paint, so a Space sent the moment the card shows can be lost.
 */
async function revealFirstCard(page: Page): Promise<void> {
  await page.getByTestId('reveal-button').click();
  await expect(page.getByTestId('card-back')).toBeVisible();
}

test.describe('Study redo', () => {
  test('rate, undo, redo by button and shortcut; a new answer clears redo', async ({ page }) => {
    await page.goto('/?device=redo');
    const card = page.getByTestId('study-card');
    await expect(card).toBeVisible();
    const newCount = page.getByTestId('count-new');
    const initial = Number(await newCount.textContent());
    expect(initial).toBeGreaterThan(1);
    const redo = page.getByTestId('study-redo');
    await expect(redo).toHaveCount(0);

    await revealFirstCard(page);
    await page.keyboard.press('2');
    await expect(newCount).toHaveText(String(initial - 1));
    const afterRating = await card.textContent();

    await page.keyboard.press('z');
    await expect(newCount).toHaveText(String(initial));
    await expect(redo).toBeVisible();

    // Redo: the same review is back, and the same next card shows.
    await redo.click();
    await expect(newCount).toHaveText(String(initial - 1));
    await expect(card).toHaveText(afterRating ?? '');
    await expect(redo).toHaveCount(0);

    // Undo and redo again with the keyboard.
    await page.keyboard.press('z');
    await expect(newCount).toHaveText(String(initial));
    await page.keyboard.press('Control+Shift+Z');
    await expect(newCount).toHaveText(String(initial - 1));

    // A new answer after an undo ends the redo history.
    await page.keyboard.press('z');
    await expect(redo).toBeVisible();
    await page.keyboard.press('Space');
    await page.keyboard.press('1');
    await expect(redo).toHaveCount(0);
    await page.keyboard.press('Control+y');
    await expect(redo).toHaveCount(0);

    // The redone review is stored like any other: it survives a reload.
    await page.keyboard.press('z');
    await expect(newCount).toHaveText(String(initial));
    await page.keyboard.press('Control+y');
    await expect(newCount).toHaveText(String(initial - 1));
    // Saving is asynchronous (§8): reload only once all five recorded reviews (two answers and
    // three redos) are in IndexedDB.
    await expect.poll(() => countStoredReviews(page, 'flashcards-db-redo')).toBe(5);
    await page.reload();
    await expect(card).toBeVisible();
    await expect(newCount).toHaveText(String(initial - 1));
  });

  test('the Redo button fits a 320 px screen without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/?device=redophone');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await revealFirstCard(page);
    await page.keyboard.press('2');
    await page.keyboard.press('z');
    await expect(page.getByTestId('study-redo')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
