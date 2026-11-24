import { expect, test } from '@playwright/test';

/** Redo after Undo in Study: the undone review comes back, and a new answer ends the redo history. */

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

    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
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
    await page.keyboard.press('Control+y');
    const stored = await newCount.textContent();
    await page.reload();
    await expect(card).toBeVisible();
    await expect(newCount).toHaveText(stored ?? '');
  });

  test('the Redo button fits a 320 px screen without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/?device=redophone');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.keyboard.press('Space');
    await page.keyboard.press('2');
    await page.keyboard.press('z');
    await expect(page.getByTestId('study-redo')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
