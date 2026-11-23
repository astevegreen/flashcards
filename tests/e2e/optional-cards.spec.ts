import { expect, test, type Page } from '@playwright/test';

const RECOGNITION = 'layout:vocab-ko:recognition';
const browseHeading = (page: Page) => page.locator('h1', { hasText: 'Browse' });
const row = (page: Page, text: string) =>
  page.locator('[data-testid^="browse-row-"]', { hasText: text });

async function setKoreanRecognitionRule(page: Page, value: string): Promise<void> {
  await page.getByRole('button', { name: 'Library' }).first().click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  const koRow = page.locator('[data-testid^="deck-row-"]', { hasText: 'Korean Core + Hanja' });
  const select = koRow.getByTestId(`layout-required-field-${RECOGNITION}`);
  if (!(await select.isVisible())) {
    await koRow.getByRole('button', { name: 'Options' }).click();
  }
  await select.selectOption(value);
  await expect(select).toHaveValue(value);
}

async function openKoreanBrowse(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Browse' }).first().click();
  await expect(page.getByTestId('browse-list')).toBeVisible();
  await page.getByLabel('Filter by deck').selectOption({ label: 'Korean Core + Hanja' });
}

test.describe('Optional cards', () => {
  test('a layout rule makes cards only for filled fields; emptied cards keep history', async ({
    page,
  }) => {
    await page.goto('/?device=optcards');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Only 학교 has Notes filled, so Recognition makes one card instead of four.
    await setKoreanRecognitionRule(page, 'notes');
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('count-new')).toHaveText('1');
    await expect(page.getByTestId('front-field-word')).toContainText('학교');
    await page.getByTestId('reveal-button').click();
    await page.getByTestId('rate-good').click();

    // Now require an empty field: 학교's card has history, so it stays, flagged Empty.
    await setKoreanRecognitionRule(page, 'image');
    await openKoreanBrowse(page);
    await expect(browseHeading(page)).toContainText('(4)');
    await expect(row(page, '학교').getByTestId('browse-empty-badge')).toHaveText('Empty');
    await page.getByTestId('browse-state-filter').selectOption('empty');
    await expect(browseHeading(page)).toContainText('(1)');
    await page.getByTestId('browse-state-filter').selectOption('due');
    await expect(browseHeading(page)).toContainText('(0)');

    // Study skips it.
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('count-new')).toHaveText('0');

    // Removing the rule brings every card back, 학교 with its review.
    await setKoreanRecognitionRule(page, '');
    await openKoreanBrowse(page);
    await page.getByTestId('browse-state-filter').selectOption('empty');
    await expect(browseHeading(page)).toContainText('(0)');
    await page.getByTestId('browse-state-filter').selectOption('new');
    await expect(browseHeading(page)).toContainText('(3)');
    await expect(row(page, '학교')).toHaveCount(0);
  });
});
