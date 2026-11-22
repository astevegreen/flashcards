import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 14 target "first card on screen <= 30 s and <= 3 taps after install, with no sign-in",
 * as a regression guard on the production preview build. Each test gets a fresh browser context
 * (empty storage, no `?device=`), which is the closest a browser gets to a first launch. These
 * are developer measurements (see docs/onboarding-review.md), not the non-technical tester audit
 * on real devices that Phase 14 requires.
 */

const TAP_TARGET = 3;
const TIME_TARGET_MS = 30_000;
/**
 * Regression bound, well inside the target: measured runs take well under a second, so a run
 * that needs 10 s means something got much slower (the 30 s target stays the documented bar).
 */
const TIME_REGRESSION_MS = 10_000;

interface FirstCardRun {
  taps: number;
  elapsedMs: number;
  firstLanguage: string | null;
}

/** First launch to the first study card through onboarding, counting every tap. */
async function firstLaunchToFirstCard(page: Page, useTouch: boolean): Promise<FirstCardRun> {
  let taps = 0;
  const tap = async (target: Locator) => {
    taps += 1;
    if (useTouch) await target.tap();
    else await target.click();
  };

  const started = Date.now();
  await page.goto('/');
  const onboarding = page.getByTestId('onboarding');
  const firstLanguage = onboarding.getByTestId(/^onboarding-language-/).first();
  await expect(firstLanguage).toBeVisible();
  const firstLanguageId = await firstLanguage.getAttribute('data-testid');
  await tap(firstLanguage);
  // Generic: the starter deck slugs change with the curated decks.
  await tap(onboarding.getByTestId(/^onboarding-deck-/).first());
  await expect(page.getByTestId('study-card')).toBeVisible();
  return { taps, elapsedMs: Date.now() - started, firstLanguage: firstLanguageId };
}

function report(label: string, run: FirstCardRun, testInfo: { annotations: object[] }) {
  const description = `${label}: ${run.taps} taps, ${run.elapsedMs} ms (first language ${run.firstLanguage})`;
  testInfo.annotations.push({ type: 'first-card', description });
  console.log(`[phase14-first-card] ${description}`);
}

test.describe('Phase 14 first card on screen', () => {
  test('desktop: first launch to the first card in <= 3 taps, well under 30 s, no sign-in', async ({
    page,
  }, testInfo) => {
    const origin = new URL(testInfo.project.use.baseURL ?? 'http://127.0.0.1').origin;
    const run = await firstLaunchToFirstCard(page, false);
    report('desktop 1280x720', run, testInfo);
    // Korean first on a non-Korean device (approved order); nothing preselected.
    expect(run.firstLanguage).toBe('onboarding-language-ko');
    expect(run.taps).toBeLessThanOrEqual(TAP_TARGET);
    expect(run.elapsedMs).toBeLessThan(TIME_TARGET_MS);
    expect(run.elapsedMs, 'well under the 30 s target').toBeLessThan(TIME_REGRESSION_MS);
    // No sign-in: the page never left the app.
    expect(new URL(page.url()).origin).toBe(origin);
  });

  test('phone (390x844, touch): first launch to the first card in <= 3 taps', async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const run = await firstLaunchToFirstCard(page, true);
    report('phone 390x844 touch', run, testInfo);
    expect(run.taps).toBeLessThanOrEqual(TAP_TARGET);
    expect(run.elapsedMs).toBeLessThan(TIME_TARGET_MS);
    expect(run.elapsedMs, 'well under the 30 s target').toBeLessThan(TIME_REGRESSION_MS);
    await context.close();
  });
});

test.describe('Phase 14 onboarding decisions (approved 2026-11-22)', () => {
  test('a Korean-locale device lists English first, then Korean', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ko-KR' });
    const page = await context.newPage();
    await page.goto('/');
    const languages = page.getByTestId('onboarding').getByTestId(/^onboarding-language-/);
    await expect(languages.first()).toHaveAttribute('data-testid', 'onboarding-language-en');
    await expect(languages.nth(1)).toHaveAttribute('data-testid', 'onboarding-language-ko');
    await context.close();
  });

  test('Reset Local Device Data offers onboarding again, like a fresh install', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('onboarding-language-ko').click();
    await page
      .getByTestId('onboarding')
      .getByTestId(/^onboarding-deck-/)
      .first()
      .click();
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: 'Reset Local Device Data' }).click();
    await expect(page.getByText('Local device storage cleared.')).toBeVisible();
    await page.getByRole('button', { name: 'Study', exact: true }).first().click();
    await expect(page.getByTestId('onboarding')).toBeVisible();

    // And it stays a fresh install after a reload (the record is gone from the device store).
    await page.reload();
    await expect(page.getByTestId('onboarding')).toBeVisible();
  });
});
