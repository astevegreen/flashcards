import { expect, test, type Page } from '@playwright/test';

/**
 * The duplicate panel stays correct while it is open: a note edit that breaks a duplicate removes
 * its group, and one that creates a duplicate adds it, without closing and reopening the panel.
 * (The panel recomputes its groups on each state change; this pins the result, not the method.)
 */

async function editWord(page: Page, word: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Word').fill(word);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe('Duplicate finder while open', () => {
  test('a note edit that breaks or creates a duplicate updates the groups', async ({ page }) => {
    await page.goto('/?device=dupelive');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // An imported list that repeats the sample deck's 학교.
    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByPlaceholder('Deck name (e.g., TOPIK II Verbs)').fill('TOPIK list');
    await page.getByRole('button', { name: 'Create Deck' }).click();
    await expect(page.getByText('Created deck "TOPIK list".')).toBeVisible();
    await page.getByTestId('bring-my-cards-btn').click();
    await page.getByTestId('bring-link-input').fill('Word,Meaning\n학교 (學校),school\n바다,ocean');
    await page.getByTestId('bring-link-submit').click();
    await page.getByTestId('bring-csv-target').selectOption({ label: 'TOPIK list' });
    await page.getByTestId('bring-csv-import-btn').click();
    await expect(page.getByTestId('bring-csv-status')).toContainText('Imported 2 note(s)');

    await page.getByRole('button', { name: 'Browse' }).first().click();
    await expect(page.getByTestId('browse-list')).toBeVisible();
    await page.getByTestId('open-duplicate-finder').click();
    const finder = page.getByTestId('duplicate-finder');
    const count = finder.getByTestId('duplicate-group-count');
    await expect(count).toHaveText('(1)');

    // Break it: rename the imported copy from the group. The panel stays open and drops the group.
    const imported = finder
      .getByTestId('duplicate-group')
      .locator('[data-testid^="duplicate-note-"]', { hasText: 'TOPIK list' });
    await imported.getByTestId('duplicate-open').click();
    await editWord(page, '학교생활');
    await expect(finder).toBeVisible();
    await expect(count).toHaveText('(0)');
    await expect(finder).toContainText('No duplicates found.');

    // Create it again: set the word back from the Browse list.
    await page.getByTestId('browse-list').getByText('학교생활').first().click();
    await editWord(page, '학교 (學校)');
    await expect(finder).toBeVisible();
    await expect(count).toHaveText('(1)');
    await expect(finder.getByTestId('duplicate-group')).toContainText('TOPIK list');
  });
});
