import { expect, test, type Page } from '@playwright/test';

/** Find and replace across the selected notes, from the Browse bulk edit bar, and its undo. */

async function openKoreanSelection(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Words' }).first().click();
  await expect(page.getByTestId('browse-list')).toBeVisible();
  await page.getByLabel('Filter by deck').selectOption({ label: 'Korean Core + Hanja' });
  await expect(page.locator('h1', { hasText: 'Words' })).toContainText('(4)');
  await page.getByTestId('browse-select-all').check();
  await expect(page.getByTestId('bulk-selected-count')).toHaveText('4 notes selected');
}

test.describe('Find and replace', () => {
  test('previews, replaces in the selected notes, and undoes', async ({ page }) => {
    await page.goto('/?device=findreplace');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openKoreanSelection(page);

    await page.getByTestId('bulk-find-replace').click();
    const panel = page.getByTestId('find-replace-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('find-replace-apply')).toBeDisabled();

    await panel.getByTestId('find-replace-find').fill('SCHOOL');
    await panel.getByTestId('find-replace-replace').fill('academy');
    await expect(panel.getByTestId('find-replace-summary')).toHaveText('1 match in 1 note.');
    await expect(panel.getByTestId('find-replace-preview')).toContainText('academy');

    // Match case: no match for the upper-case text.
    await panel.getByTestId('find-replace-match-case').check();
    await expect(panel.getByTestId('find-replace-summary')).toHaveText(
      'No matches in the selected notes.',
    );
    await panel.getByTestId('find-replace-match-case').uncheck();

    // A broken pattern is refused, not applied.
    await panel.getByTestId('find-replace-regex').check();
    await panel.getByTestId('find-replace-find').fill('(');
    await expect(panel.getByTestId('find-replace-summary')).toContainText(
      'not a valid regular expression',
    );
    await expect(panel.getByTestId('find-replace-apply')).toBeDisabled();
    await panel.getByTestId('find-replace-find').fill('sch(ool)');
    await panel.getByTestId('find-replace-replace').fill('academy [$1]');

    await panel.getByTestId('find-replace-apply').click();
    await expect(panel.getByTestId('find-replace-message')).toHaveText(
      'Replaced 1 match in 1 note.',
    );
    const list = page.getByTestId('browse-list');
    await expect(list).toContainText('academy [ool]');

    await panel.getByTestId('find-replace-undo').click();
    await expect(panel.getByTestId('find-replace-message')).toHaveText(
      'Put back the old text in 1 field.',
    );
    await expect(list).not.toContainText('academy');
    await expect(list).toContainText('school');

    await panel.getByTestId('find-replace-close').click();
    await expect(panel).toHaveCount(0);
  });

  test('fits a phone-width screen without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/?device=findreplacephone');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openKoreanSelection(page);
    await page.getByTestId('bulk-find-replace').click();
    await expect(page.getByTestId('find-replace-panel')).toBeVisible();
    await page.getByTestId('find-replace-find').fill('school');
    await expect(page.getByTestId('find-replace-preview')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
