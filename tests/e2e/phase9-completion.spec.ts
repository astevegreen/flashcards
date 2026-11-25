import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const KOREAN = 'Korean Core + Hanja';

async function openStudy(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Study' }).first().click();
  await expect(page.getByLabel('Select deck to study')).toBeVisible();
}

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId('study-filter-btn').click();
  await expect(page.getByTestId('study-filter-panel')).toBeVisible();
}

const undoButton = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });

/** Cards left in the session (new + learning + due). */
const remaining = (page: Page) =>
  Promise.all(
    ['count-new', 'count-learning', 'count-due'].map(async (id) =>
      Number(await page.getByTestId(id).textContent()),
    ),
  ).then((xs) => xs.reduce((a, b) => a + b, 0));

test.describe('Phase 9 completion', () => {
  test('a category rename in the tag manager carries saved Study Sets along', async ({ page }) => {
    await page.goto('/?device=p9done-sets');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Save a #hanja set.
    await openPanel(page);
    await page.getByTestId('study-filter-category-toggle').click();
    await page.getByTestId('study-filter-category-option-hanja').locator('xpath=..').click();
    await expect(page.getByTestId('study-filter-count-custom')).toHaveText('3 due · 3 cards');
    await page.getByTestId('study-filter-save-custom').click();
    await page.getByTestId('study-set-name-input').fill('Hanja words');
    await page.getByTestId('study-set-save-confirm').click();
    await expect(page.getByTestId('study-set-row')).toHaveCount(1);
    await page.getByTestId('study-filter-close').click();

    // Rename #hanja to #한자 for the whole collection.
    await page.getByRole('button', { name: 'Words' }).first().click();
    await page.getByTestId('open-tag-manager').click();
    const manager = page.getByTestId('tag-manager');
    await manager.getByTestId('tag-rename-hanja').click();
    await manager.getByTestId('tag-rename-input').fill('한자');
    await manager.getByTestId('tag-rename-submit').click();
    await expect(manager.getByTestId('tag-manager-message')).toContainText(
      'on 3 notes. Updated 1 study set.',
    );

    // The set still selects the same three cards.
    await openStudy(page);
    await openPanel(page);
    const row = page.getByTestId('study-set-row');
    await expect(row.getByTestId('study-set-name')).toHaveText('Hanja words');
    await expect(row.getByTestId('study-set-count')).toHaveText('3 due · 3 cards');
    await row.getByTestId('study-set-start').click();
    await expect(page.getByTestId('count-new')).toHaveText('3');
    await expect(page.getByTestId('study-card')).not.toContainText('약속');
  });

  test('Practice: Undo is disabled until there is an answer to undo', async ({ page }) => {
    await page.goto('/?device=p9done-undo');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: KOREAN });
    await openPanel(page);
    await page.getByTestId('custom-practice-start').click();
    await expect(page.getByTestId('study-filter-chip')).toContainText('Practice');
    await expect(undoButton(page)).toBeDisabled();

    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect.poll(() => remaining(page)).toBe(4);
    await page.keyboard.press('2');
    await expect.poll(() => remaining(page)).toBe(3);
    await expect(undoButton(page)).toBeEnabled();
    await undoButton(page).click();
    await expect.poll(() => remaining(page)).toBe(4);
    await expect(undoButton(page)).toBeDisabled();
  });

  test('Stats: the category filter narrows every number', async ({ page }) => {
    await page.goto('/?device=p9done-stats');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: KOREAN });
    for (let i = 1; i <= 2; i++) {
      await page.keyboard.press('Space');
      await expect(page.getByTestId('card-back')).toBeVisible();
      await page.keyboard.press('2');
      await expect(page.getByTestId('count-new')).toHaveText(String(4 - i));
    }

    await page.getByRole('button', { name: 'Stats' }).first().click();
    await expect(page.getByTestId('stats-screen')).toBeVisible();
    await expect(page.getByTestId('stats-today-reviews')).toHaveText('2');

    // #topik-2 is the one Korean word not studied yet; #topik-1 holds both studied words.
    await page.getByTestId('stats-category-toggle').click();
    await page.getByTestId('stats-category-option-topik-2').locator('xpath=..').click();
    await expect(page.getByTestId('stats-today-reviews')).toHaveText('0');
    await page.getByTestId('stats-category-option-topik-2').locator('xpath=..').click();
    await page.getByTestId('stats-category-option-topik-1').locator('xpath=..').click();
    await expect(page.getByTestId('stats-today-reviews')).toHaveText('2');

    // The deck filter narrows the category's deck list; Japanese has no #topik-1 cards.
    await page
      .getByLabel('Filter stats by deck')
      .selectOption({ label: 'Japanese Essentials (JA)' });
    await expect(page.getByTestId('stats-today-reviews')).toHaveText('0');
  });

  test('Library: export one category as CSV and .flashpkg', async ({ page }) => {
    await page.goto('/?device=p9done-export');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByTestId('import-export-btn').click();
    await page.getByTestId('import-export-tab-export').click();
    const panel = page.getByRole('region', { name: 'Export a tag' });
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('category-export-csv')).toBeDisabled();

    await panel.getByLabel('Tag to export').selectOption('hanja');
    // Only the Korean deck holds #hanja, so CSV can export it without choosing a deck.
    await expect(panel.getByTestId('category-export-csv')).toBeEnabled();
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByTestId('category-export-csv').click(),
    ]);
    expect(csv.suggestedFilename()).toBe('korean-core-hanja-hanja.csv');
    const text = readFileSync((await csv.path()) ?? '', 'utf8');
    expect(text).toContain('학교');
    expect(text).toContain('도서관');
    expect(text).not.toContain('약속');
    await expect(page.getByTestId('library-status')).toContainText('Exported 3 notes in #hanja');

    const [pkg] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByTestId('category-export-flashpkg').click(),
    ]);
    expect(pkg.suggestedFilename()).toBe('hanja.flashpkg');
    await expect(page.getByTestId('library-status')).toContainText('as hanja.flashpkg');
  });
});
