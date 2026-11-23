import { expect, test } from '@playwright/test';

const HAN = /[㐀-鿿]/u;

test.describe('Per-layout ruby display flag', () => {
  test('editing an existing layout switches Study to readings only or bases only', async ({
    page,
  }) => {
    await page.goto('/?device=rubyflag');
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Library' }).first().click();
    const jaRow = page.locator('[data-testid^="deck-row-"]', {
      hasText: 'Japanese Essentials (JA)',
    });
    await jaRow.getByRole('button', { name: 'Options' }).click();

    // The add-layout form has the selector too, and it starts on both.
    await expect(
      jaRow.locator('[data-testid^="add-layout-form-"]').getByLabel('Ruby shows'),
    ).toHaveValue('both');

    const select = jaRow.getByLabel('Ruby shows for Recognition');
    await expect(select).toHaveValue('both');
    await select.selectOption('readings');
    await expect(select).toHaveValue('readings');
    await jaRow.getByRole('button', { name: 'Study' }).click();

    const card = page.getByTestId('study-card');
    await page
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Essentials (JA)' });
    const word = card.getByTestId('front-field-word');
    await expect(word).toBeVisible();
    await expect(card.locator('rt')).toHaveCount(0);
    await expect(word).not.toHaveText(HAN);
    // F has nothing to toggle on a readings-only layout.
    await expect(
      page.locator('button[aria-pressed][title*="readings or bases only"]'),
    ).toBeDisabled();

    // Back in the Library: bases only.
    await page.getByRole('button', { name: 'Library' }).first().click();
    const optionsBtn = jaRow.getByRole('button', { name: 'Options' });
    if (await optionsBtn.isVisible()) await optionsBtn.click();
    await jaRow.getByLabel('Ruby shows for Recognition').selectOption('bases');
    await jaRow.getByRole('button', { name: 'Study' }).click();
    await page
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Essentials (JA)' });
    await expect(card.getByTestId('front-field-word')).toBeVisible();
    await expect(card.locator('rt')).toHaveCount(0);
    await expect(card.getByTestId('front-field-word')).toHaveText(HAN);
  });
});
