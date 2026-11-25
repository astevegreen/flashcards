import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 13 adaptive layout: the core study flow on every device project in playwright.config.ts
 * (small phone, phone, landscape phone, foldable cover, tablet portrait / landscape, desktop).
 */

const LONG_GRAMMAR = Array.from(
  { length: 18 },
  (_, i) =>
    `${i + 1}. -(으)ㄹ 수 있다 expresses ability or possibility: 한국어를 읽을 수 있어요 means "I can read Korean". ` +
    'Attach -을 수 있다 after a final consonant and -ㄹ 수 있다 after a vowel; negate with 없다.',
).join(' ');

async function viewportSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

async function expectNoPageScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return {
      scrollHeight: el.scrollHeight,
      scrollWidth: el.scrollWidth,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
    };
  });
  expect(metrics.scrollHeight, 'page must not scroll vertically').toBeLessThanOrEqual(
    metrics.innerHeight + 1,
  );
  expect(metrics.scrollWidth, 'page must not scroll horizontally').toBeLessThanOrEqual(
    metrics.innerWidth + 1,
  );
  // The study screen's own container must not hide content off to the side either.
  const main = await page
    .locator('main')
    .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(main.scrollWidth, 'study content must not overflow sideways').toBeLessThanOrEqual(
    main.clientWidth + 1,
  );
}

/** Fully inside the viewport and not hidden under the fixed bottom tab bar. */
async function expectInViewport(page: Page, locator: Locator, label: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} has a box`).toBeTruthy();
  if (!box) return;
  const { width, height } = await viewportSize(page);
  const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navBox = (await mobileNav.isVisible()) ? await mobileNav.boundingBox() : null;
  const bottomLimit = navBox ? navBox.y : height;
  expect(box.x, `${label} left`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `${label} top`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} right`).toBeLessThanOrEqual(width + 1);
  expect(box.y + box.height, `${label} bottom`).toBeLessThanOrEqual(bottomLimit + 1);
}

async function expectTouchTargets(page: Page, scope: Locator, label: string): Promise<void> {
  const small = await scope.evaluate((root) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('button, select')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // display: none
      if (r.height < 44 || r.width < 44) {
        out.push(
          `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim()}" ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
      }
    }
    return out;
  });
  expect(small, `${label}: touch targets under 44 px`).toEqual([]);
}

test.describe('Phase 13 adaptive study layout', () => {
  test('study screen fits the viewport: card and rating buttons on screen, no page scroll', async ({
    page,
  }, testInfo) => {
    await page.goto('/?device=layout');
    const card = page.getByTestId('study-card');
    await expect(card).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('front-field-word')).toBeVisible();

    const { width, height } = await viewportSize(page);
    const isShortLandscape = height <= 500 && width > height;
    const isSmall = width < 360;
    const isTouch = Boolean(testInfo.project.use.hasTouch);
    const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' });
    const main = page.locator('main');

    // Front: card + Show Answer fit without page scroll.
    await expectNoPageScroll(page);
    await expectInViewport(page, card, 'card (front)');
    await expectInViewport(page, page.getByTestId('reveal-button'), 'Show Answer');

    if (isShortLandscape) {
      // Compact layout: bottom tabs hidden while studying, the slim rail keeps navigation reachable.
      await expect(mobileNav).toBeHidden();
      await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Decks' }).first()).toBeVisible();
    }

    if (isSmall) {
      // Icon-only tabs that keep their accessible labels.
      await expect(mobileNav).toBeVisible();
      const libraryTab = mobileNav.getByRole('button', { name: 'Decks' });
      await expect(libraryTab).toBeVisible();
      const labelBox = await libraryTab.locator('span').last().boundingBox();
      expect(labelBox?.width ?? 0).toBeLessThanOrEqual(1);
    }

    // Back: rating buttons fit too.
    await page.getByTestId('reveal-button').click();
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expectNoPageScroll(page);
    await expectInViewport(page, card, 'card (back)');
    for (const id of ['rate-again', 'rate-good', 'rate-easy']) {
      await expectInViewport(page, page.getByTestId(id), id);
    }

    if (isShortLandscape) {
      const cardBox = await card.boundingBox();
      const barBox = await page.getByTestId('rating-bar').boundingBox();
      expect(cardBox && barBox && barBox.x >= cardBox.x + cardBox.width - 1).toBe(true);
    }

    if (isSmall || isTouch) {
      await expectTouchTargets(page, main, 'study screen');
      if (await mobileNav.isVisible()) await expectTouchTargets(page, mobileNav, 'tab bar');
    }

    if (width >= 1440) {
      // Large monitors: the study card stays centered with a capped width.
      const cardBox = await card.boundingBox();
      const mainBox = await main.boundingBox();
      expect(cardBox && mainBox).toBeTruthy();
      if (cardBox && mainBox) {
        expect(cardBox.width).toBeLessThanOrEqual(900);
        expect(
          Math.abs(cardBox.x + cardBox.width / 2 - (mainBox.x + mainBox.width / 2)),
        ).toBeLessThanOrEqual(2);
      }
    }

    // Rating still works from the adaptive layout.
    const newBefore = Number(await page.getByTestId('count-new').textContent());
    await page.getByTestId('rate-good').click();
    await expect(page.getByTestId('count-new')).toHaveText(String(newBefore - 1));
    await expectNoPageScroll(page);
  });

  test('long grammar text scrolls inside the card, never the page', async ({ page }) => {
    await page.goto('/?device=layoutlong');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('front-field-word')).toBeVisible();

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    // The word field is a single-line input: one long paragraph that wraps.
    await dialog.locator('input[type="text"]').first().fill(LONG_GRAMMAR);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('front-field-word')).toContainText('expresses ability');

    await expectNoPageScroll(page);
    const body = page.getByTestId('study-card-body');
    const overflow = await body.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
    await expectInViewport(page, page.getByTestId('reveal-button'), 'Show Answer');

    // Reading size stays readable (>= 16 px) and the card body scrolls on its own.
    const fontPx = await page
      .getByTestId('front-field-word')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontPx).toBeGreaterThanOrEqual(16);
    await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expectNoPageScroll(page);
  });
});
