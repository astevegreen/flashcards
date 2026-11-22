import { expect, test, type Page } from '@playwright/test';

/** Phase 13: dictionary list + detail split view on tablets, wider content on large monitors. */

test.use({
  viewport: { width: 820, height: 1180 },
  hasTouch: true,
  isMobile: true,
  // Fail a stuck click with the step that hung instead of the bare 30 s test timeout.
  actionTimeout: 10_000,
});

async function openKoreanDictionary(page: Page): Promise<void> {
  await page.goto('/?device=dictsplit');
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('pack-row-dict-krdict')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('pack-install-btn-dict-krdict').click();
  await expect(page.getByTestId('pack-installed-badge-dict-krdict')).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'Browse' }).first().click();
  await page.getByTestId('browse-tab-dictionary').click();
  await expect(page.getByTestId('dictionary-panel')).toBeVisible();
}

test.describe('Phase 13 dictionary split view', () => {
  test('tablet portrait shows the result list beside a detail pane', async ({ page }) => {
    await openKoreanDictionary(page);
    await page.getByTestId('dictionary-search-input').fill('ㅎㄱ');

    const results = page.getByTestId('dictionary-results');
    const detail = page.getByTestId('dictionary-detail');
    await expect(results.getByTestId('dict-entry-한국').first()).toBeVisible({ timeout: 5_000 });
    await expect(results.getByTestId('dict-entry-학교').first()).toBeVisible();

    // List + detail side by side; the first result is shown in detail.
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('dict-detail-headword')).toHaveText('한국');
    const listBox = await results.boundingBox();
    const detailBox = await detail.boundingBox();
    expect(listBox && detailBox).toBeTruthy();
    if (listBox && detailBox) {
      expect(detailBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width - 1);
      expect(Math.abs(detailBox.y - listBox.y)).toBeLessThanOrEqual(2);
    }
    // In split view the list rows are compact: full senses live in the detail pane.
    await expect(results.getByTestId('dict-senses-한국').first()).toBeHidden();
    await expect(detail).toContainText('Korea');

    // Tap a row's Details button to show it in detail.
    await results.getByTestId('dict-show-학교').first().click();
    await expect(detail.getByTestId('dict-detail-headword')).toHaveText('학교');
    await expect(results.getByTestId('dict-entry-학교').first()).toHaveAttribute(
      'data-selected',
      'true',
    );

    // Keyboard / D-pad: the Details button selects without a pointer.
    const showHanguk = results.getByTestId('dict-show-한국').first();
    await showHanguk.focus();
    await page.keyboard.press('Enter');
    await expect(detail.getByTestId('dict-detail-headword')).toHaveText('한국');
    await expect(showHanguk).toHaveAttribute('aria-pressed', 'true');

    // Add to Deck still works from the list row.
    await results.getByTestId('dict-add-btn-한국').first().click();
    await expect(results.getByTestId('dict-add-bar-한국')).toBeVisible();
  });

  test('phones keep the single-column list with inline senses', async ({ page }) => {
    // Installs the pack at phone size too: Settings no longer reflows when the first sync lands.
    await page.setViewportSize({ width: 390, height: 844 });
    await openKoreanDictionary(page);
    await page.getByTestId('dictionary-search-input').fill('먹었어요');
    const results = page.getByTestId('dictionary-results');
    await expect(results.getByTestId('dict-entry-먹다').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('dictionary-detail')).toBeHidden();
    await expect(results.getByTestId('dict-senses-먹다').first()).toBeVisible();
  });

  test('large monitors widen Browse / Dictionary while study stays capped', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openKoreanDictionary(page);
    const browseMain = await page.locator('main').boundingBox();
    expect(browseMain?.width ?? 0).toBeGreaterThan(1100);

    await page.getByRole('button', { name: 'Study' }).first().click();
    await expect(page.getByTestId('study-card')).toBeVisible();
    const studyMain = await page.locator('main').boundingBox();
    expect(studyMain?.width ?? 0).toBeLessThanOrEqual(900);
  });
});
