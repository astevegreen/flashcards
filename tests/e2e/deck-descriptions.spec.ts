import { expect, test } from '@playwright/test';
import { deckRow, openLibrary, startInLibrary } from './helpers/library.ts';

test.describe('Deck descriptions', () => {
  test('a described deck shows its overview before study; others start at once', async ({
    page,
  }) => {
    await startInLibrary(page, 'deckdescriptions');

    // No description yet: Study starts at once.
    await deckRow(page).getByRole('button', { name: 'Study', exact: true }).click();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect(page.getByTestId('deck-organization-panel')).toHaveCount(0);

    // Add a plain-text description; markup stays literal text.
    await openLibrary(page);
    await deckRow(page).getByRole('button', { name: 'Options' }).click();
    const field = deckRow(page).getByLabel('Deck description');
    await field.fill('Core words with Hanja.\n<b>Not bold</b>');
    await field.blur();
    await deckRow(page).getByRole('button', { name: 'Hide' }).click();

    await deckRow(page).getByRole('button', { name: 'Study', exact: true }).click();
    const overview = deckRow(page).locator('[data-testid^="deck-overview-text-"]');
    await expect(overview).toHaveText('Core words with Hanja.\n<b>Not bold</b>');
    await expect(overview.locator('b')).toHaveCount(0);

    // Survives a reload, then "Start studying" opens the study screen.
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);
    await deckRow(page).getByRole('button', { name: 'Study', exact: true }).click();
    await expect(overview).toContainText('Core words with Hanja.');
    await deckRow(page).locator('[data-testid^="deck-overview-start-"]').click();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect(page.getByTestId('deck-organization-panel')).toHaveCount(0);
  });
});
