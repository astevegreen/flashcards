import { expect, type Locator, type Page } from '@playwright/test';

/** The Korean sample deck every fresh device starts with. */
export const KO_DECK = 'Korean Core + Hanja';

/** Opens the Library screen and waits for it. */
export async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Decks' }).first().click();
  await expect(page.getByTestId('deck-organization-panel')).toBeVisible();
}

/** Loads the app on a fresh device id, waits for the first card, then opens the Library. */
export async function startInLibrary(page: Page, device: string): Promise<void> {
  await page.goto(`/?device=${device}`);
  await expect(page.getByTestId('study-card')).toBeVisible();
  await openLibrary(page);
}

/** The Library row of the deck named `name`. */
export function deckRow(page: Page, name = KO_DECK): Locator {
  return page.locator('[data-testid^="deck-row-"]', { hasText: name });
}
