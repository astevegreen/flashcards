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

  // P7: the live preview ran the whole plan (the user's pattern over every selected note) on each
  // keystroke. Each plan run builds the search pattern once, so counting `new RegExp` for it counts
  // the runs: typing "school" quickly is one preview run, plus one on Replace.
  test('previews once per pause in typing, and plans again on Replace', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __findRuns: number };
      w.__findRuns = 0;
      globalThis.RegExp = new Proxy(RegExp, {
        construct(target, args: [string | RegExp, string?], newTarget) {
          if (args[1]?.includes('g') && 'school'.startsWith(String(args[0])) && args[0] !== '') {
            w.__findRuns += 1;
          }
          return Reflect.construct(target, args, newTarget) as RegExp;
        },
      });
    });
    await page.goto('/?device=findreplaceruns');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openKoreanSelection(page);
    await page.getByTestId('bulk-find-replace').click();
    const panel = page.getByTestId('find-replace-panel');
    const runs = () =>
      page.evaluate(() => (window as unknown as { __findRuns: number }).__findRuns);

    await panel.getByTestId('find-replace-find').pressSequentially('school', { delay: 20 });
    await expect(panel.getByTestId('find-replace-summary')).toHaveText('1 match in 1 note.');
    // Six keystrokes: six runs before P7. One once typing pauses (some slack for a slow runner).
    expect(await runs()).toBeLessThanOrEqual(2);

    const beforeApply = await runs();
    await panel.getByTestId('find-replace-replace').fill('academy');
    await expect(panel.getByTestId('find-replace-preview')).toContainText('academy');
    await panel.getByTestId('find-replace-apply').click();
    await expect(panel.getByTestId('find-replace-message')).toHaveText(
      'Replaced 1 match in 1 note.',
    );
    await expect(page.getByTestId('browse-list')).toContainText('academy');
    // The preview for the new replacement text, then a fresh plan on Replace.
    expect(await runs()).toBeLessThanOrEqual(beforeApply + 3);
  });

  // P7: the preview waits for a pause in typing, so Replace must not wait for it or use it. Enter
  // right after typing replaces what is typed: with no preview yet, and with a preview of older text.
  test('Replace uses what is typed, before the preview catches up', async ({ page }) => {
    await page.goto('/?device=findreplacefresh');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openKoreanSelection(page);
    await page.getByTestId('bulk-find-replace').click();
    const panel = page.getByTestId('find-replace-panel');
    const list = page.getByTestId('browse-list');

    await panel.getByTestId('find-replace-find').fill('school');
    await panel.getByTestId('find-replace-replace').fill('academy');
    await panel.getByTestId('find-replace-replace').press('Enter');
    await expect(panel.getByTestId('find-replace-message')).toHaveText(
      'Replaced 1 match in 1 note.',
    );
    await expect(list).toContainText('academy');

    await panel.getByTestId('find-replace-undo').click();
    await expect(list).toContainText('school');
    // Let the preview catch up with one replacement, then change it and press Enter at once.
    await panel.getByTestId('find-replace-replace').fill('old college');
    await expect(panel.getByTestId('find-replace-preview')).toContainText('old college');
    await panel.getByTestId('find-replace-replace').fill('college');
    await panel.getByTestId('find-replace-replace').press('Enter');
    await expect(panel.getByTestId('find-replace-message')).toHaveText(
      'Replaced 1 match in 1 note.',
    );
    await expect(list).toContainText('college');
    await expect(list).not.toContainText('old college');
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
