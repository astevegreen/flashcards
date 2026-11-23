import { expect, test, type Page } from '@playwright/test';

/**
 * UX #2: options for one language appear only while that language is active: it has an
 * unarchived deck, was chosen at onboarding, or is ticked in Settings > Languages. The production
 * preview without `?device=` boots to an empty collection, so onboarding with the Korean starter
 * deck gives a Korean-only collection. Korean shows Hanja as plain text: no ruby options.
 */

const NEW_DECK_CSV = 'word,meaning\n日本[にほん],Japan\n';
const RUBY_TOGGLE = /^Ruby (On|Off)$/;

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
  await expect(page.getByTestId('languages-card')).toBeVisible();
}

async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Library' }).first().click();
  await expect(page.locator('h1', { hasText: 'Library' })).toBeVisible();
}

async function openStudy(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Study' }).first().click();
  await expect(page.getByTestId('study-card')).toBeVisible();
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

async function importJapaneseDeck(page: Page): Promise<void> {
  await openBringMyCards(page);
  await dropCsv(page, NEW_DECK_CSV);
  await page.getByTestId('bring-csv-language').selectOption('ja');
  await page.getByTestId('bring-csv-note-type').selectOption('preset:vocab-ja');
  await page.getByTestId('bring-csv-import-btn').click();
  await expect(page.getByTestId('bring-csv-status')).toHaveAttribute('data-phase', 'done');
}

async function expectJapaneseOptions(page: Page, shown: boolean): Promise<void> {
  await openSettings(page);
  await expect(page.getByText('Japanese typed mode: Hiragana = Katakana')).toHaveCount(
    shown ? 1 : 0,
  );
  await expect(page.getByTestId('drawing-mode-select-ja')).toHaveCount(shown ? 1 : 0);
  await openStudy(page);
  await expect(page.getByRole('button', { name: RUBY_TOGGLE })).toHaveCount(shown ? 1 : 0);
}

test.describe('Language-aware options (UX #2)', () => {
  test('a Korean-only collection shows no ruby, furigana or pinyin options', async ({ page }) => {
    await onboardKorean(page);

    // Study: no Ruby toggle (Hanja is plain text).
    await expect(page.getByRole('button', { name: RUBY_TOGGLE })).toHaveCount(0);

    // Settings: no pinyin, tone or kana options, no Japanese/Mandarin voices or drawing rows;
    // Korean's own options stay. Korean is ticked and locked (it has a deck).
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
    await expect(page.getByTestId('language-toggle-ko')).toBeChecked();
    await expect(page.getByTestId('language-toggle-ko')).toBeDisabled();
    await expect(page.getByTestId('language-toggle-ja')).not.toBeChecked();
    await expect(page.getByTestId('language-toggle-zh-Hans')).not.toBeChecked();

    // Library: no per-layout ruby selector and no "Ruby shows" in Add layout.
    await openLibrary(page);
    const koRow = page.locator('[data-testid^="deck-row-"]').first();
    await koRow.getByRole('button', { name: 'Options' }).click();
    await expect(koRow.locator('[data-testid^="add-layout-form-"]')).toBeVisible();
    await expect(koRow.getByLabel('Ruby shows')).toHaveCount(0);
    await expect(koRow.locator('[data-testid^="layout-ruby-list-"]')).toHaveCount(0);

    // Import: no Anki furigana switch until the new deck's language is Japanese.
    await openBringMyCards(page);
    await dropCsv(page, NEW_DECK_CSV);
    await expect(page.getByTestId('bring-csv-anki-ruby')).toHaveCount(0);
    await page.getByTestId('bring-csv-language').selectOption('ja');
    await expect(page.getByTestId('bring-csv-anki-ruby')).toBeVisible();
  });

  test('archiving the only Japanese deck hides furigana; un-archiving or ticking Japanese brings it back', async ({
    page,
  }) => {
    await onboardKorean(page);
    await importJapaneseDeck(page);

    // The Japanese deck makes Japanese active, and its tick box is locked.
    await expectJapaneseOptions(page, true);
    await openSettings(page);
    await expect(page.getByTestId('language-toggle-ja')).toBeChecked();
    await expect(page.getByTestId('language-toggle-ja')).toBeDisabled();

    // Archive it: furigana and the other Japanese options go away; nothing is deleted.
    await openLibrary(page);
    const jaRow = page.locator('[data-testid^="deck-row-"]', { hasText: 'second' });
    await jaRow.getByRole('button', { name: 'Options' }).click();
    await jaRow.locator('[data-testid^="archive-deck-btn-"]').click();
    await expect(page.locator('[data-testid^="deck-row-"]', { hasText: 'second' })).toHaveCount(0);
    await expectJapaneseOptions(page, false);
    await openSettings(page);
    await expect(page.getByTestId('language-toggle-ja')).not.toBeChecked();
    await expect(page.getByTestId('language-toggle-ja')).toBeEnabled();

    // Un-archive: back again.
    await openLibrary(page);
    await page.getByTestId('toggle-archived-decks-btn').click();
    await page.locator('[data-testid^="restore-deck-btn-"]').first().click();
    await expect(page.locator('[data-testid^="deck-row-"]', { hasText: 'second' })).toHaveCount(1);
    await expectJapaneseOptions(page, true);

    // Archive again, then tick Japanese in Settings: furigana is back with no Japanese deck.
    await openLibrary(page);
    const row = page.locator('[data-testid^="deck-row-"]', { hasText: 'second' });
    await row.getByRole('button', { name: 'Options' }).click();
    await row.locator('[data-testid^="archive-deck-btn-"]').click();
    await expectJapaneseOptions(page, false);

    await openSettings(page);
    await page.getByTestId('language-toggle-ja').check();
    await expect(page.getByTestId('language-toggle-ja')).toBeChecked();
    await expectJapaneseOptions(page, true);

    // The choice is stored (an appended preference event): it survives a reload.
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect(page.getByRole('button', { name: RUBY_TOGGLE })).toBeVisible();

    // Unticking hides it again.
    await openSettings(page);
    await page.getByTestId('language-toggle-ja').uncheck();
    await expectJapaneseOptions(page, false);
  });
});
