import { expect, test, type Page } from '@playwright/test';

/** Phase 13: keyboard / D-pad focus navigation on the study screen. */

async function activeTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

async function newCount(page: Page): Promise<number> {
  return Number(await page.getByTestId('count-new').textContent());
}

/** Enter on the focused Show Answer / Reveal more button until the card is fully revealed. */
async function revealAllWithEnter(page: Page): Promise<void> {
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('card-back')).toBeVisible();
  const more = page.getByTestId('reveal-more-button');
  for (let i = 0; i < 6 && (await more.isVisible()); i++) {
    // Multi-step cards: focus follows to "Reveal more", the next action.
    await expect(more).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(more).toHaveCount(0);
  // Fully revealed: focus lands on the default rating (Good) instead of falling to <body>.
  await expect(page.getByTestId('rate-good')).toBeFocused();
}

test.describe('Phase 13 keyboard and D-pad navigation', () => {
  test('logical tab order, visible focus rings, arrow keys move between rating buttons', async ({
    page,
  }) => {
    await page.goto('/?device=keyboard');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.locator('body').click({ position: { x: 1, y: 1 } });

    // Tab walks the header controls in DOM order before reaching Show Answer.
    const seen: string[] = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute('data-testid') ?? el?.getAttribute('aria-label') ?? el?.tagName;
      });
      seen.push(String(id));
      if (id === 'reveal-button') break;
    }
    expect(seen).toContain('reveal-button');
    expect(seen.indexOf('Select deck to study')).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf('Select deck to study')).toBeLessThan(seen.indexOf('reveal-button'));

    const reveal = page.getByTestId('reveal-button');
    await expect(reveal).toBeFocused();
    const ring = await reveal.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(ring.style).toBe('solid');
    expect(ring.width).toBeGreaterThanOrEqual(2);

    // Enter flips; focus moves to the next sensible control each step.
    const before = await newCount(page);
    await revealAllWithEnter(page);

    // Arrows move focus between rating buttons (and wrap) without rating.
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('rate-easy')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('rate-again')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('rate-easy')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByTestId('rate-again')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('rate-good')).toBeFocused();
    expect(await newCount(page)).toBe(before);
    const goodRing = await page
      .getByTestId('rate-good')
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(goodRing).toBe('solid');

    // Enter rates the focused button; focus returns to Show Answer for the next card.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('count-new')).toHaveText(String(before - 1));
    await expect(reveal).toBeFocused();
    expect(await activeTestId(page)).toBe('reveal-button');

    // Number keys keep working while a rating button has focus.
    await revealAllWithEnter(page);
    await page.keyboard.press('2');
    await expect(page.getByTestId('count-new')).toHaveText(String(before - 2));

    // With nothing focused, the §5.1 arrow shortcuts still rate (← = Good) and undo (→ = Back).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('count-new')).toHaveText(String(before - 3));
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('count-new')).toHaveText(String(before - 2));
  });

  test('mouse users keep Space-to-reveal: no focus is moved onto rating buttons', async ({
    page,
  }) => {
    await page.goto('/?device=keyboardmouse');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByTestId('reveal-button').click();
    await expect(page.getByTestId('card-back')).toBeVisible();
    expect(await activeTestId(page)).not.toBe('rate-good');
  });
});
