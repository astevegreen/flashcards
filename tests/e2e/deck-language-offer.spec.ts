import { expect, test, type Page } from '@playwright/test';
import { storedPayloads } from './helpers/stored-events.ts';
import { deckRow, startInLibrary } from './helpers/library.ts';

/**
 * A Sentence deck whose sentences are Korean but whose language is English (as decks linked from
 * a sheet before C8 were) gets a one-time offer in the Library to set its language. Either answer
 * is stored as events, so the offer stays gone after a reload.
 */

const DECK = 'Old Sentences';
const CSV =
  'sentence,translation\n저는 학생이에요.,I am a student.\n커피 주세요.,"Coffee, please."\n';

/** Imports a Korean Sentence CSV as an English deck, then closes the import panel. */
async function importEnglishKoreanDeck(page: Page): Promise<void> {
  await page.getByTestId('import-export-btn').click();
  await expect(page.getByTestId('bring-my-cards-panel')).toBeVisible();
  await page.getByTestId('bring-drop-zone').evaluate((zone, csv) => {
    const data = new DataTransfer();
    data.items.add(new File([csv], 'sentences.csv', { type: 'text/csv' }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
  }, CSV);
  await expect(page.getByTestId('bring-route')).toHaveAttribute('data-kind', 'csv');
  await page.getByTestId('bring-csv-note-type').selectOption('preset:sentence');
  await page.getByTestId('bring-csv-language').selectOption('en');
  await page.getByTestId('bring-csv-deck-name').fill(DECK);
  await page.getByTestId('bring-csv-import-btn').click();
  await expect(page.getByTestId('bring-csv-status')).toHaveAttribute('data-phase', 'done');
  await page.reload();
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByRole('button', { name: 'Decks' }).first().click();
  await expect(deckRow(page, DECK)).toBeVisible();
}

test.describe('Deck language offer', () => {
  test('taking the offer sets the language; Undo puts it back; it never returns', async ({
    page,
  }) => {
    await startInLibrary(page, 'langoffer-a');
    await importEnglishKoreanDeck(page);

    const row = deckRow(page, DECK);
    // Only the mismatched deck is asked; the sample decks are not.
    await expect(page.locator('[data-testid^="deck-language-offer-"]')).toHaveCount(1);
    await expect(row.locator('[data-testid^="deck-language-offer-"]')).toContainText(
      'looks Korean',
    );
    await row.getByRole('button', { name: 'Set to Korean' }).click();
    await expect(row.getByText('ko', { exact: true })).toBeVisible();
    await expect(row.locator('[data-testid^="deck-language-changed-"]')).toBeVisible();

    await row.getByRole('button', { name: 'Undo' }).click();
    await expect(row.getByText('en', { exact: true })).toBeVisible();
    await expect(row.locator('[data-testid^="deck-language-"]')).toHaveCount(0);

    const db = 'flashcards-db-langoffer-a';
    await expect
      .poll(async () => (await storedPayloads(page, db, 'DeckLanguageOffered')).length)
      .toBe(1);
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await expect(deckRow(page, DECK)).toBeVisible();
    await expect(page.locator('[data-testid^="deck-language-offer-"]')).toHaveCount(0);
  });

  test('keeping the language records the answer and the offer stays gone', async ({ page }) => {
    await startInLibrary(page, 'langoffer-b');
    await importEnglishKoreanDeck(page);

    const row = deckRow(page, DECK);
    await row.getByRole('button', { name: 'Keep English' }).click();
    await expect(row.locator('[data-testid^="deck-language-"]')).toHaveCount(0);
    await expect(row.getByText('en', { exact: true })).toBeVisible();

    const db = 'flashcards-db-langoffer-b';
    await expect
      .poll(async () => storedPayloads(page, db, 'DeckLanguageOffered'))
      .toEqual([expect.objectContaining({ language: 'ko', accepted: false })]);
    expect(await storedPayloads(page, db, 'DeckSettingsChanged')).not.toContainEqual(
      expect.objectContaining({ language: 'ko' }),
    );
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await expect(deckRow(page, DECK)).toBeVisible();
    await expect(page.locator('[data-testid^="deck-language-offer-"]')).toHaveCount(0);
  });
});
