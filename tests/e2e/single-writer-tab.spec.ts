import { expect, test } from '@playwright/test';
import { rateOne, storedEvents } from './helpers/writer-tabs.ts';

/**
 * One writer per browser profile (Web Locks): a second tab of the same database shows "open in
 * another tab" and writes nothing; "Use here instead" moves writing to it, from the latest stored
 * state, and the first tab switches to the same screen.
 */

const DEVICE = 'onewriter';
const DB = `flashcards-db-${DEVICE}`;

test('a second tab waits, then "Use here instead" moves writing to it and back', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const first = await context.newPage();
  await first.goto(`/?device=${DEVICE}`);
  await expect(first.getByTestId('study-card')).toBeVisible();
  const newAtStart = Number(await first.getByTestId('count-new').textContent());

  const second = await context.newPage();
  await second.goto(`/?device=${DEVICE}`);
  const screen = second.getByTestId('other-tab');
  await expect(screen).toContainText('Flashcards is open in another tab.');
  await expect(second.getByTestId('study-card')).toHaveCount(0);
  // Fits a 320 px phone without sideways scrolling.
  expect(
    await second.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  // The first tab still writes; the waiting tab adds nothing.
  await rateOne(first);
  const afterFirst = await storedEvents(first, DB);
  await second.waitForTimeout(300); // NOSONAR (S2925): a negative needs a timed window
  expect(await storedEvents(second, DB)).toBe(afterFirst);

  // Take over: the second tab boots from storage (sees the first tab's review), the first stops.
  await screen.getByRole('button', { name: 'Use here instead' }).click();
  await expect(second.getByTestId('study-card')).toBeVisible();
  await expect(second.getByTestId('count-new')).toHaveText(String(newAtStart - 1));
  await expect(first.getByTestId('other-tab')).toBeVisible();
  await expect(first.getByTestId('study-card')).toHaveCount(0);

  await rateOne(second);
  const afterSecond = await storedEvents(second, DB);
  expect(afterSecond).toBeGreaterThan(afterFirst);

  // ...and the first tab can take it back the same way.
  await first.getByRole('button', { name: 'Use here instead' }).click();
  await expect(first.getByTestId('count-new')).toHaveText(String(newAtStart - 2));
  await expect(second.getByTestId('other-tab')).toBeVisible();
  expect(await storedEvents(first, DB)).toBe(afterSecond);

  await context.close();
});

test('a waiting tab takes over by itself when the writer tab closes', async ({ browser }) => {
  const context = await browser.newContext();
  const device = `/?device=${DEVICE}auto`;
  const writer = await context.newPage();
  await writer.goto(device);
  await expect(writer.getByTestId('study-card')).toBeVisible();
  await rateOne(writer);
  const newAfterRating = Number(await writer.getByTestId('count-new').textContent());

  const waiting = await context.newPage();
  await waiting.goto(device);
  await expect(waiting.getByTestId('other-tab')).toBeVisible();

  await writer.close();

  // No tap: the lock frees and the waiting tab boots, with the closed tab's review saved.
  await expect(waiting.getByTestId('study-card')).toBeVisible();
  await expect(waiting.getByTestId('count-new')).toHaveText(String(newAfterRating));
  await rateOne(waiting);

  await context.close();
});
