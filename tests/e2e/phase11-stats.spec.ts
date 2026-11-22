import { expect, test } from '@playwright/test';

test.describe('Phase 11 Stats screen', () => {
  test('opens Stats from nav, shows reviews after studying Korean cards, and filters by deck', async ({
    page,
  }) => {
    await page.goto('/?device=stats');
    const card = page.getByTestId('study-card');
    await expect(card).toBeVisible();

    // Study two Korean sample cards (flip + Good).
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(card).toBeVisible();
    const startNew = Number(await page.getByTestId('count-new').textContent());
    expect(startNew).toBeGreaterThanOrEqual(2);
    for (let i = 1; i <= 2; i++) {
      await page.keyboard.press('Space');
      await expect(page.getByTestId('card-back')).toBeVisible();
      await page.keyboard.press('2');
      await expect(page.getByTestId('count-new')).toHaveText(String(startNew - i));
    }

    // Open Stats from the primary navigation (lazy-loaded screen).
    await page.getByRole('button', { name: 'Stats' }).first().click();
    await expect(page.getByRole('heading', { name: 'Statistics' })).toBeVisible();
    const screen = page.getByTestId('stats-screen');
    await expect(screen).toBeVisible();

    await expect(page.getByTestId('stats-today-reviews')).toHaveText('2');
    await expect(page.getByTestId('stats-current-streak')).toHaveText('1 day');
    await expect(page.getByTestId('stats-reviews-summary')).toContainText('2 reviews');
    await expect(page.getByTestId('stats-reviews-chart')).toBeVisible();
    await expect(page.getByTestId('stats-forecast-chart')).toBeVisible();
    await expect(page.getByTestId('stats-heatmap')).toBeVisible();
    await expect(page.getByTestId('stats-heatmap').locator('rect[data-count="2"]')).toHaveCount(1);
    await expect(page.getByTestId('stats-maturity-learning')).toHaveText('2');
    // The two studied cards are learning and due again today.
    await expect(page.getByTestId('stats-forecast-summary')).toContainText('2 cards due');

    // Deck filter: the Korean deck owns both reviews; the Japanese deck has none.
    const filter = page.getByLabel('Filter stats by deck');
    await filter.selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('stats-today-reviews')).toHaveText('2');
    await expect(page.getByTestId('stats-retention-target')).toHaveText('90.0%');

    await filter.selectOption({ label: 'Japanese Essentials (JA)' });
    await expect(page.getByTestId('stats-today-reviews')).toHaveText('0');
    await expect(page.getByTestId('stats-current-streak')).toHaveText('0 days');
    await expect(page.getByTestId('stats-maturity-learning')).toHaveText('0');
    await expect(page.getByRole('status').filter({ hasText: 'No reviews yet' })).toBeVisible();

    await filter.selectOption({ label: 'All Decks' });
    await expect(page.getByTestId('stats-today-reviews')).toHaveText('2');

    // The data table view is available for the per-day chart.
    const reviewsCard = page.getByTestId('stats-reviews-card');
    await reviewsCard.getByText('Show data').click();
    await expect(reviewsCard.locator('tbody tr').first().locator('td').nth(1)).toHaveText('2');

    // Undo from Study removes the review from the stats as well.
    await page.getByRole('button', { name: 'Study' }).first().click();
    await expect(card).toBeVisible();
    await page.keyboard.press('z');
    await expect(page.getByTestId('count-new')).toHaveText(String(startNew - 1));
    await page.getByRole('button', { name: 'Stats' }).first().click();
    await expect(page.getByTestId('stats-today-reviews')).toHaveText('1');
  });
});
