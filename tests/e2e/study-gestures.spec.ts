import { expect, test, type Locator, type Page } from '@playwright/test';

async function dragCard(
  page: Page,
  card: Locator,
  from: { xFrac: number; yFrac: number },
  to: { xFrac: number; yFrac: number },
  expectedIntentLabel?: string,
) {
  const box = await card.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  const startX = box.x + box.width * from.xFrac;
  const startY = box.y + box.height * from.yFrac;
  const endX = box.x + box.width * to.xFrac;
  const endY = box.y + box.height * to.yFrac;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 6 });
  if (expectedIntentLabel) {
    await expect(page.getByTestId('swipe-intent-badge')).toHaveText(expectedIntentLabel);
  }
  await page.mouse.up();
}

test.describe('Study gestures, reveal cycling, and third-side layout', () => {
  test('swipe directions (left=Good, down=Again, up=Easy, right=Undo) work from front and back', async ({
    page,
  }) => {
    await page.goto('/?device=gestures1');
    const card = page.getByTestId('study-card');
    await expect(card).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    const firstWord = await page.getByTestId('front-field-word').textContent();
    expect(firstWord).toBeTruthy();

    const initialNew = Number(await page.getByTestId('count-new').textContent());
    expect(initialNew).toBeGreaterThanOrEqual(3);

    // Non-overflowing card sets touch-action: none so vertical drags are never cancelled on Android.
    const body = page.getByTestId('study-card-body');
    await expect(body).toHaveAttribute('data-overflowing', 'false');
    const touchAction = await body.evaluate((el) => getComputedStyle(el).touchAction);
    expect(touchAction).toBe('none');

    // Swipe RIGHT when nothing to undo: shows "Back" intent, then no-ops (count & word unchanged).
    await dragCard(page, card, { xFrac: 0.2, yFrac: 0.5 }, { xFrac: 0.85, yFrac: 0.5 }, 'Back');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew));
    await expect(page.getByTestId('front-field-word')).toHaveText(firstWord ?? '');

    // Swipe LEFT on FRONT (unrevealed) -> shows "Good" intent and rates immediately.
    await expect(page.getByTestId('card-back')).toHaveCount(0);
    await dragCard(page, card, { xFrac: 0.85, yFrac: 0.5 }, { xFrac: 0.15, yFrac: 0.5 }, 'Good');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew - 1));
    await expect(page.getByTestId('front-field-word')).not.toHaveText(firstWord ?? '');

    // Swipe RIGHT -> Undo (returns to previous card).
    await dragCard(page, card, { xFrac: 0.2, yFrac: 0.5 }, { xFrac: 0.85, yFrac: 0.5 }, 'Back');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew));
    await expect(page.getByTestId('front-field-word')).toHaveText(firstWord ?? '');

    // Swipe DOWN -> shows "Again" intent and rates Again from front.
    await dragCard(page, card, { xFrac: 0.5, yFrac: 0.2 }, { xFrac: 0.5, yFrac: 0.85 }, 'Again');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew - 1));
    await expect(page.getByTestId('front-field-word')).not.toHaveText(firstWord ?? '');

    // Swipe RIGHT -> Undo Again.
    await dragCard(page, card, { xFrac: 0.2, yFrac: 0.5 }, { xFrac: 0.85, yFrac: 0.5 }, 'Back');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew));
    await expect(page.getByTestId('front-field-word')).toHaveText(firstWord ?? '');

    // Swipe UP -> shows "Easy" intent and rates directly from front.
    await dragCard(page, card, { xFrac: 0.5, yFrac: 0.85 }, { xFrac: 0.5, yFrac: 0.15 }, 'Easy');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew - 1));
  });

  test('tap and Space cycle through reveal steps and open the third-side extras panel', async ({
    page,
  }) => {
    await page.goto('/?device=gestures2');
    const card = page.getByTestId('study-card');
    await expect(card).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('front-field-word')).toBeVisible();

    const body = page.getByTestId('study-card-body');
    const hint = page.getByTestId('card-reveal-hint');

    // Front (step 0)
    await expect(body).toHaveAttribute('data-revealed', 'false');
    await expect(body).toHaveAttribute('data-extras-open', 'false');
    await expect(hint).toHaveText('Tap card or press Space to reveal');

    // Tap 1 -> step 1 (answer revealed, more steps remain)
    await card.click();
    await expect(body).toHaveAttribute('data-revealed', 'true');
    await expect(body).toHaveAttribute('data-extras-open', 'false');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(hint).toHaveText('Tap for more •••');
    await expect(page.getByTestId('card-extras-panel')).toHaveCount(0);

    // Tap 2 -> step 2 (final step: third-side extras panel opens, prompt moves to top)
    await card.click();
    await expect(body).toHaveAttribute('data-extras-open', 'true');
    await expect(page.getByTestId('card-extras-panel')).toBeVisible();
    await expect(hint).toHaveText('Tap to return to answer');

    // Tap 3 -> cycles back to step 1 (extras hidden, still revealed)
    await card.click();
    await expect(body).toHaveAttribute('data-revealed', 'true');
    await expect(body).toHaveAttribute('data-extras-open', 'false');
    await expect(page.getByTestId('card-extras-panel')).toHaveCount(0);
    await expect(hint).toHaveText('Tap for more •••');

    // Space also cycles step 1 -> step 2 -> step 1
    await page.keyboard.press('Space');
    await expect(body).toHaveAttribute('data-extras-open', 'true');
    await expect(page.getByTestId('card-extras-panel')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(body).toHaveAttribute('data-extras-open', 'false');
  });

  test('keyboard arrow parity: ArrowLeft=Good, ArrowDown=Again, ArrowUp=Easy, ArrowRight=Undo', async ({
    page,
  }) => {
    await page.goto('/?device=gestures3');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const initialNew = Number(await page.getByTestId('count-new').textContent());
    const firstWord = await page.getByTestId('front-field-word').textContent();

    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew - 1));
    await expect(page.getByTestId('front-field-word')).not.toHaveText(firstWord ?? '');

    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew));
    await expect(page.getByTestId('front-field-word')).toHaveText(firstWord ?? '');

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew - 1));

    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew));
    await expect(page.getByTestId('front-field-word')).toHaveText(firstWord ?? '');

    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNew - 1));
  });

  test('touch devices show a one-time dismissible swipe tutorial hint that stays dismissed', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto('/?device=gesturesguide');
    await expect(page.getByTestId('study-card')).toBeVisible();

    const guide = page.getByTestId('swipe-guide');
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('← Good');
    await expect(guide).toContainText('↓ Again');
    await expect(guide).toContainText('↑ Easy');
    await expect(guide).toContainText('→ Back');

    await page.getByTestId('swipe-guide-dismiss').click();
    await expect(guide).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect(page.getByTestId('swipe-guide')).toHaveCount(0);
    await context.close();
  });
});
