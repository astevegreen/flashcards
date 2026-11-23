import { expect, test, type Page } from '@playwright/test';

async function installPacks(page: Page, packIds: readonly string[]): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  for (const id of packIds) {
    await expect(page.getByTestId(`pack-row-${id}`)).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`pack-install-btn-${id}`).click();
    await expect(page.getByTestId(`pack-installed-badge-${id}`)).toBeVisible({ timeout: 10_000 });
  }
}

test.describe('Dictionary browse without typing', () => {
  test('home groups, level list with 초성 jump and POS filter, topics, Hanja links, direction, recents', async ({
    page,
  }) => {
    await page.goto('/?device=dictbrowse');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await installPacks(page, ['dict-krdict', 'dict-hanja-unihan']);

    await page.getByRole('button', { name: 'Browse' }).first().click();
    await page.getByTestId('browse-tab-dictionary').click();
    const panel = page.getByTestId('dictionary-panel');
    await expect(panel).toBeVisible();

    // 1. The dictionary opens with something to browse: levels, topics, a Hanja grid.
    const home = page.getByTestId('dictionary-home');
    await expect(home.getByTestId('dict-home-dict-krdict')).toBeVisible({ timeout: 5_000 });
    await expect(home.getByTestId('dict-browse-dict-krdict-level-advanced')).toContainText('2');
    await expect(home.getByTestId('dict-browse-dict-krdict-topic-학교생활')).toContainText(
      'School life',
    );
    await expect(home.getByTestId('dict-hanja-tile-韓')).toBeVisible();

    // 2. A level opens a 가나다 list; the jump bar and POS chips narrow it without typing.
    await home.getByTestId('dict-browse-dict-krdict-level-beginner').click();
    await expect(page.getByTestId('dict-browse-title')).toHaveText('Beginner · 초급');
    const results = page.getByTestId('dictionary-results');
    await expect(results.locator('article').first()).toHaveAttribute(
      'data-testid',
      'dict-entry-가다',
    );
    await page.getByTestId('dict-jump-ㅎ').click();
    await expect(results.getByTestId('dict-entry-학교')).toBeVisible();
    await expect(results.getByTestId('dict-entry-가다')).toHaveCount(0);
    await page.getByTestId('dict-pos-filter-verb').click();
    await expect(results.getByTestId('dict-entry-하다')).toBeVisible();
    await expect(results.getByTestId('dict-entry-학교')).toHaveCount(0);
    // Browse rows keep Add to Deck.
    await expect(results.getByTestId('dict-add-btn-하다')).toBeVisible();

    // 3. Back to the home, then a topic.
    await page.getByTestId('dict-browse-back').click();
    await home.getByTestId('dict-browse-dict-krdict-topic-학교생활').click();
    await expect(results.getByTestId('dict-entry-도서관')).toBeVisible();
    await expect(results.getByTestId('dict-entry-먹다')).toHaveCount(0);

    // 4. Hanja ↔ word: a word's Hanja opens the character and every word written with it.
    await results.getByTestId('dict-hanja-link-學').first().click();
    await expect(page.getByTestId('dictionary-search-input')).toHaveValue('學');
    await expect(results.locator('article').first()).toHaveAttribute(
      'data-testid',
      'dict-entry-學',
    );
    await expect(page.getByTestId('dict-words-with-hanja')).toContainText('學');
    await expect(results.getByTestId('dict-entry-학교')).toBeVisible();
    await expect(results.getByTestId('dict-entry-학생')).toBeVisible();

    // 5. Direction: Latin letters are romanization into English, and English the other way.
    const input = page.getByTestId('dictionary-search-input');
    await input.fill('hanguk');
    await expect(results.locator('article').first()).toHaveAttribute(
      'data-testid',
      'dict-entry-한국',
    );
    await page.getByTestId('dict-direction-from-english').click();
    await expect(page.getByTestId('dict-no-results')).toBeVisible();
    await input.fill('school');
    await input.press('Enter');
    await expect(results.locator('article').first()).toHaveAttribute(
      'data-testid',
      'dict-entry-학교',
    );
    await expect(results.getByTestId('dict-gloss-lead-학교')).toContainText('school');

    // 6. Recent lookups show on the home once the box is cleared, and the direction is kept.
    await input.fill('');
    await page.getByTestId('dict-browse-back').click();
    await expect(home.getByTestId('dict-recent-學')).toBeVisible();
    await expect(home.getByTestId('dict-recent-school')).toBeVisible({ timeout: 5_000 });
    await page.reload();
    await page.getByRole('button', { name: 'Browse' }).first().click();
    await page.getByTestId('browse-tab-dictionary').click();
    await expect(page.getByTestId('dict-direction-from-english')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await home.getByTestId('dict-recent-school').click();
    await expect(input).toHaveValue('school');
  });
});
