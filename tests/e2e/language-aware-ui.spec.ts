import { expect, test, type Page } from '@playwright/test';

/**
 * UX #2: options for one language appear only while that language is in the collection or was
 * chosen at onboarding. The production preview without `?device=` boots to an empty collection,
 * so onboarding with the Korean starter deck gives a Korean-only collection.
 */

const NEW_DECK_CSV = 'word,meaning\n사과,apple\n';

async function onboardKorean(page: Page): Promise<void> {
  await page.goto('/');
  const onboarding = page.getByTestId('onboarding');
  await onboarding.getByTestId('onboarding-language-ko').click();
  await onboarding
    .getByTestId(/^onboarding-deck-/)
    .first()
    .click();
  await expect(page.getByTestId('study-card')).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('audio-tts-card')).toBeVisible();
}

async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Library' }).first().click();
  await expect(page.locator('h1', { hasText: 'Library' })).toBeVisible();
}

async function openBringMyCards(page: Page): Promise<void> {
  await openLibrary(page);
  await page.getByTestId('bring-my-cards-btn').click();
  await expect(page.getByTestId('bring-my-cards-panel')).toBeVisible();
}

async function dropCsv(page: Page, text: string): Promise<void> {
  await page.getByTestId('bring-drop-zone').evaluate((zone, csv) => {
    const data = new DataTransfer();
    data.items.add(new File([csv], 'second.csv', { type: 'text/csv' }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
  }, text);
  await expect(page.getByTestId('bring-route')).toHaveAttribute('data-kind', 'csv');
}

test.describe('Language-aware options (UX #2)', () => {
  test('a Korean-only collection shows no pinyin or Japanese options; importing a Japanese deck brings them back', async ({
    page,
  }) => {
    await onboardKorean(page);

    // Study: ruby is not Japanese-only (the Korean starter uses Hanja ruby), so the toggle stays.
    await expect(page.getByRole('button', { name: /^Ruby (On|Off)$/ })).toBeVisible();

    // Settings: no pinyin, tone or kana options, no Japanese/Mandarin voices or drawing rows;
    // Korean's own options stay.
    await openSettings(page);
    await expect(page.getByText('Pinyin tone colors')).toHaveCount(0);
    await expect(page.getByText('Mandarin typed mode: Ignore tones')).toHaveCount(0);
    await expect(page.getByText('Japanese typed mode: Hiragana = Katakana')).toHaveCount(0);
    await expect(page.getByTestId('tts-test-lang-select').locator('option')).toHaveText([
      'Korean (ko)',
    ]);
    await expect(page.getByTestId('drawing-mode-select-ko')).toBeVisible();
    await expect(page.getByTestId('drawing-mode-select-ja')).toHaveCount(0);
    await expect(page.getByTestId('drawing-mode-select-zh-Hans')).toHaveCount(0);

    // Library: ruby display applies to Korean too.
    await openLibrary(page);
    const koRow = page.locator('[data-testid^="deck-row-"]').first();
    await koRow.getByRole('button', { name: 'Options' }).click();
    await expect(koRow.locator('[data-testid^="add-layout-form-"]')).toBeVisible();
    await expect(koRow.getByLabel('Ruby shows').first()).toBeVisible();

    // Import: the Anki furigana switch is language-neutral for ja/ko/zh.
    await openBringMyCards(page);
    await dropCsv(page, NEW_DECK_CSV);
    await expect(page.getByTestId('bring-csv-anki-ruby')).toBeVisible();
    await page.getByTestId('bring-csv-language').selectOption('ja');
    await page.getByTestId('bring-csv-note-type').selectOption('preset:vocab-ja');
    await expect(page.getByTestId('bring-csv-anki-ruby')).toBeVisible();
    await page.getByTestId('bring-csv-import-btn').click();
    await expect(page.getByTestId('bring-csv-status')).toHaveAttribute('data-phase', 'done');

    // The new language is active: Japanese options are back.
    await openSettings(page);
    await expect(page.getByText('Japanese typed mode: Hiragana = Katakana')).toBeVisible();
    await expect(page.getByTestId('drawing-mode-select-ja')).toBeVisible();
    await expect(page.getByTestId('tts-test-lang-select').locator('option')).toHaveText([
      'Japanese (ja)',
      'Korean (ko)',
    ]);
    await expect(page.getByText('Pinyin tone colors')).toHaveCount(0);

    await openLibrary(page);
    const jaRow = page.locator('[data-testid^="deck-row-"]', { hasText: 'second' });
    await jaRow.getByRole('button', { name: 'Options' }).click();
    await expect(
      jaRow.locator('[data-testid^="add-layout-form-"]').getByLabel('Ruby shows'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Study' }).first().click();
    await expect(page.getByRole('button', { name: /^Ruby (On|Off)$/ })).toBeVisible();

    // Nothing was deleted: it survives a reload.
    await page.reload();
    await expect(page.getByRole('button', { name: /^Ruby (On|Off)$/ })).toBeVisible();
  });
});
