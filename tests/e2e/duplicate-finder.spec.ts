import { expect, test, type Page } from '@playwright/test';

const browseHeading = (page: Page) => page.locator('h1', { hasText: 'Browse' });

test.describe('Duplicate finder', () => {
  test('finds a note repeated in another deck; tag and archive act on it', async ({ page }) => {
    await page.goto('/?device=dupes');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // An "imported list" that repeats 학교 from the sample deck (extra spaces, decomposed Hangul).
    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByPlaceholder('Deck name (e.g., TOPIK II Verbs)').fill('TOPIK list');
    await page.getByRole('button', { name: 'Create Deck' }).click();
    await expect(page.getByText('Created deck "TOPIK list".')).toBeVisible();
    await page.getByTestId('bring-my-cards-btn').click();
    const word = '학교 (學校)'.normalize('NFD');
    await page
      .getByTestId('bring-link-input')
      .fill(`Word,Meaning\n"  ${word} ",school\n바다,ocean`);
    await page.getByTestId('bring-link-submit').click();
    await page.getByTestId('bring-csv-target').selectOption({ label: 'TOPIK list' });
    await page.getByTestId('bring-csv-import-btn').click();
    await expect(page.getByTestId('bring-csv-status')).toContainText('Imported 2 note(s)');

    await page.getByRole('button', { name: 'Browse' }).first().click();
    await expect(page.getByTestId('browse-list')).toBeVisible();
    await page.getByTestId('open-duplicate-finder').click();
    const finder = page.getByTestId('duplicate-finder');
    await expect(finder).toBeVisible();
    await expect(finder.getByTestId('duplicate-group-count')).toHaveText('(1)');
    const group = finder.getByTestId('duplicate-group');
    await expect(group).toContainText('학교 (學校)');
    await expect(group).toContainText('Korean Core + Hanja');
    await expect(group).toContainText('TOPIK list');

    // Open shows the note in the editor.
    await group.getByTestId('duplicate-open').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Tag the group, then find it with #duplicate.
    await group.getByTestId('duplicate-tag-group').click();
    await expect(finder.getByTestId('duplicate-message')).toHaveText(
      'Tagged "duplicate" on 2 notes.',
    );
    await page
      .getByPlaceholder(/search/i)
      .first()
      .fill('#duplicate');
    await expect(browseHeading(page)).toContainText('(2)');

    // Archive the imported copy: the group goes away.
    const imported = group.locator('[data-testid^="duplicate-note-"]', { hasText: 'TOPIK list' });
    await imported.getByTestId('duplicate-archive').click();
    await expect(finder.getByTestId('duplicate-group-count')).toHaveText('(0)');
    await expect(browseHeading(page)).toContainText('(1)');
  });
});
