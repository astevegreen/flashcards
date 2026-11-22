import { expect, test, type Page } from '@playwright/test';

/** Phase 13: in-app card text size, auto-fit card text and prefers-reduced-motion. */

async function frontFontPx(page: Page): Promise<number> {
  return page
    .getByTestId('front-field-word')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

async function openKoreanDeck(page: Page): Promise<void> {
  await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
  await expect(page.getByTestId('front-field-word')).toBeVisible();
}

test.describe('Phase 13 card text size and auto-fit', () => {
  test('Settings card text size scales study text, persists on this device', async ({ page }) => {
    await page.goto('/?device=textsize');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openKoreanDeck(page);
    const mediumPx = await frontFontPx(page);

    await page.getByRole('button', { name: 'Settings' }).first().click();
    const display = page.getByTestId('display-settings-card');
    await expect(display).toBeVisible();
    await expect(display.getByTestId('card-text-size-m')).toHaveAttribute('aria-pressed', 'true');
    await display.getByTestId('card-text-size-xl').click();
    await expect(display.getByTestId('card-text-size-xl')).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Study' }).first().click();
    await openKoreanDeck(page);
    const xlPx = await frontFontPx(page);
    expect(xlPx / mediumPx).toBeCloseTo(1.45, 1);

    // Device-local: survives a reload without any sync event.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-card-text', 'xl');
    await openKoreanDeck(page);
    expect(await frontFontPx(page)).toBeCloseTo(xlPx, 0);

    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByTestId('card-text-size-s').click();
    await page.getByRole('button', { name: 'Study' }).first().click();
    await openKoreanDeck(page);
    expect((await frontFontPx(page)) / mediumPx).toBeCloseTo(0.85, 1);
  });

  test('a single Hanja fills the card; a grammar paragraph drops to a readable size', async ({
    page,
  }) => {
    await page.goto('/?device=autofit');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openKoreanDeck(page);
    const wordPx = await frontFontPx(page);

    const editWord = async (text: string) => {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const dialog = page.locator('dialog[open]');
      await dialog.locator('input[type="text"]').first().fill(text);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('front-field-word')).toContainText(text.slice(0, 8));
    };

    await editWord('學');
    const hanjaPx = await frontFontPx(page);
    const cardHeight = (await page.getByTestId('study-card-body').boundingBox())?.height ?? 0;
    expect(hanjaPx).toBeGreaterThan(wordPx * 1.8);
    // Fills a large share of the card's shorter side.
    expect(hanjaPx).toBeGreaterThan(Math.min(cardHeight, 900) * 0.3);

    await editWord(
      'Grammar: -아/어서 links two clauses by cause or sequence. 비가 와서 집에 있었어요 (It rained, so I stayed home). It cannot take past tense itself, and it cannot end in a command or suggestion.',
    );
    const paragraphPx = await frontFontPx(page);
    expect(paragraphPx).toBeLessThan(wordPx);
    expect(paragraphPx).toBeGreaterThanOrEqual(16);
    // Start-aligned with a capped line length (<= ~65ch).
    const { align, widthPx } = await page.getByTestId('front-field-word').evaluate((el) => ({
      align: getComputedStyle(el).textAlign,
      widthPx: el.getBoundingClientRect().width,
    }));
    expect(align).toBe('start');
    expect(widthPx).toBeLessThanOrEqual(paragraphPx * 65);
  });

  test('prefers-reduced-motion disables card transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/?device=motion');
    const card = page.getByTestId('study-card');
    await expect(card).toBeVisible();
    const duration = await card.evaluate((el) =>
      parseFloat(getComputedStyle(el).transitionDuration),
    );
    expect(duration).toBeLessThan(0.001);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const normal = await card.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
    expect(normal).toBeGreaterThan(0);
  });
});
