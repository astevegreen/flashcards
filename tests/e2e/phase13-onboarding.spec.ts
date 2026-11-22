import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 13 first-run onboarding (Phase 14 bar: study first, set up later). The production preview
 * without `?device=` boots to an empty collection, the only state that offers onboarding; dev
 * sessions seed sample decks, so every other spec reaches study directly and never sees it.
 */

const DECK_NAME = 'Korean Core + Hanja';

async function deckOptions(page: Page): Promise<string[]> {
  return page.getByLabel('Select deck to study').locator('option').allTextContents();
}

/** Reveals and rates Easy until the day's queue is empty (the first session is finished). */
async function finishSession(page: Page): Promise<void> {
  const caughtUp = page.getByRole('heading', { name: 'All caught up for today!' });
  for (let i = 0; i < 40; i++) {
    if (await caughtUp.isVisible()) return;
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.keyboard.press('Space');
    await page.getByTestId('rate-easy').click();
  }
  await expect(caughtUp).toBeVisible();
}

test.describe('Phase 13 first-run onboarding', () => {
  test('first run: a language, then a starter deck, and the first card is on screen in two taps', async ({
    page,
  }) => {
    await page.goto('/');
    const onboarding = page.getByTestId('onboarding');
    await expect(onboarding).toBeVisible();
    await expect(onboarding.getByRole('heading', { name: 'What are you learning?' })).toBeVisible();
    // The other ways to start stay available below it; nothing asks for a sign-in.
    await expect(page.getByRole('button', { name: 'Load Sample Decks' })).toBeVisible();

    await onboarding.getByTestId('onboarding-language-ko').click();
    await expect(onboarding.getByRole('heading', { name: 'Pick a starter deck' })).toBeVisible();
    await onboarding.getByTestId('onboarding-deck-sample-ko-vocab').click();

    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
    // Only the chosen starter deck was added, and it is the one being studied.
    expect(await deckOptions(page)).toEqual(['All Decks', DECK_NAME]);
    await expect(page.getByLabel('Select deck to study')).toHaveValue(/.+/);

    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
  });

  test('skippable, and not shown again after a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('onboarding')).toBeVisible();
    await page.getByTestId('onboarding-skip').click();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Ready to Study Offline' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Ready to Study Offline' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load Sample Decks' })).toBeVisible();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);

    // The empty screen still works exactly as before.
    await page.getByRole('button', { name: 'Load Sample Decks' }).click();
    await expect(page.getByTestId('study-card')).toBeVisible();
  });

  test('sync is offered once, after the first finished session, never before', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('onboarding-language-ko').click();
    await page.getByTestId('onboarding-deck-sample-ko-vocab').click();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect(page.getByTestId('onboarding-sync-prompt')).toHaveCount(0);

    await finishSession(page);
    const prompt = page.getByTestId('onboarding-sync-prompt');
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Sync my devices' }).click();
    // It only opens the existing sync choices in Settings.
    await expect(page.getByTestId('device-id-value')).toBeVisible();

    await page.getByRole('button', { name: 'Study', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'All caught up for today!' })).toBeVisible();
    await expect(page.getByTestId('onboarding-sync-prompt')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'All caught up for today!' })).toBeVisible();
    await expect(page.getByTestId('onboarding-sync-prompt')).toHaveCount(0);
  });

  for (const width of [320, 390]) {
    test(`the sync prompt paints with the caught-up panel, nothing moves after (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      await page.getByTestId('onboarding-language-ko').click();
      await page.getByTestId('onboarding-deck-sample-ko-vocab').click();
      await expect(page.getByTestId('study-card')).toBeVisible();
      // Sample the caught-up buttons every frame, from before the panel first paints.
      await page.evaluate(() => {
        const samples: string[] = [];
        (window as unknown as { __caughtUpSamples: string[] }).__caughtUpSamples = samples;
        const tick = () => {
          const buttons = [...document.querySelectorAll('button')].filter(
            (b) => b.textContent === 'Open Library' || b.textContent === 'Study All Decks',
          );
          if (buttons.length > 0) {
            const prompt = document.querySelector('[data-testid="onboarding-sync-prompt"]');
            samples.push(
              `${prompt ? 'prompt' : 'none'}:${buttons
                .map((b) => Math.round(b.getBoundingClientRect().top))
                .join(',')}`,
            );
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      await finishSession(page);
      await expect(page.getByTestId('onboarding-sync-prompt')).toBeVisible();
      await page.waitForLoadState('networkidle');
      const read = () =>
        page.evaluate(
          () => (window as unknown as { __caughtUpSamples: string[] }).__caughtUpSamples,
        );
      await expect.poll(async () => (await read()).length).toBeGreaterThan(30);
      const samples = await read();
      // Every frame since the panel appeared shows the prompt and the same button positions.
      expect(new Set(samples).size).toBe(1);
      expect(samples[0]).toMatch(/^prompt:/);
    });
  }

  test('"Not now" dismisses the sync prompt for good', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('onboarding-language-zh-Hans').click();
    await page
      .getByTestId('onboarding')
      .getByRole('button', { name: /Mandarin Basics/ })
      .click();
    await finishSession(page);
    await page.getByTestId('onboarding-sync-dismiss').click();
    await expect(page.getByTestId('onboarding-sync-prompt')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'All caught up for today!' })).toBeVisible();
    await expect(page.getByTestId('onboarding-sync-prompt')).toHaveCount(0);
  });
});
