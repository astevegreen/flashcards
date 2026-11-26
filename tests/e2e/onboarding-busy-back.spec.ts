import { expect, test } from '@playwright/test';

// The service worker would answer chunk requests itself; block it so `page.route` sees them.
test.use({ serviceWorkers: 'block' });

/**
 * C21: while a starter deck loads, Back is disabled like the deck buttons, so the user can't
 * leave the deck list for the language list halfway through the pick.
 */
test('onboarding Back is disabled while a starter deck loads', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/assets\/ko-core-[^/]+\.js$/, async (route) => {
    await held;
    await route.continue();
  });

  await page.goto('/');
  const onboarding = page.getByTestId('onboarding');
  await onboarding.getByTestId('onboarding-language-ko').click();
  const back = onboarding.getByRole('button', { name: 'Back' });
  await expect(back).toBeEnabled();

  const first = onboarding.getByTestId(/^onboarding-deck-/).first();
  await first.click();
  await expect(first).toBeDisabled();
  await expect(back).toBeDisabled();

  release();
  await expect(page.getByTestId('study-card')).toBeVisible();
});
