import { expect, test, type Page } from '@playwright/test';
import { replayAllEvents } from '../../packages/core/src/events/replay.ts';
import type { FlashEvent } from '../../packages/core/src/events/types.ts';
import { computeHardestCards } from '../../packages/core/src/stats/filtered.ts';

/**
 * Stats "Hardest cards" passes the screen's filter (deck + category), the default limit and the
 * device time zone to the same core ranking MCP `get_weak_cards` calls: the rendered order equals
 * `computeHardestCards` over this device's own event log for the same filter.
 */

const KOREAN = 'Korean Core + Hanja';
const dbNameFor = (page: Page) => `flashcards-db-${new URL(page.url()).searchParams.get('device')}`;

async function readEvents(page: Page): Promise<FlashEvent[]> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<FlashEvent[]>((resolve, reject) => {
        const req = db.transaction('events', 'readonly').objectStore('events').getAll();
        req.onsuccess = () => resolve(req.result as FlashEvent[]);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, dbNameFor(page));
}

async function expectedOrder(page: Page, filter: unknown): Promise<string[]> {
  const tzOffsetMinutes = await page.evaluate(() => -new Date().getTimezoneOffset());
  const state = replayAllEvents(await readEvents(page));
  return computeHardestCards(state, filter, { nowMs: Date.now(), tzOffsetMinutes }).map(
    (c) => c.id,
  );
}

const renderedOrder = (page: Page) =>
  page
    .getByTestId('stats-hardest-list')
    .locator('li')
    .evaluateAll((items) => items.map((li) => li.getAttribute('data-card-id') ?? ''));

test.describe('Phase 13 Stats hardest cards', () => {
  test('a category filter narrows the list, in the same order as the core ranking', async ({
    page,
  }) => {
    await page.goto('/?device=p13-hardest');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: KOREAN });
    // Good, then Easy: two #topik-1 words with clearly different stability.
    for (const [i, rating] of ['rate-good', 'rate-easy'].entries()) {
      await page.keyboard.press('Space');
      await expect(page.getByTestId('card-back')).toBeVisible();
      await page.getByTestId(rating).click();
      await expect(page.getByTestId('count-new')).toHaveText(String(3 - i));
    }

    await page.getByRole('button', { name: 'Stats' }).first().click();
    await expect(page.getByTestId('stats-screen')).toBeVisible();
    await expect(page.getByTestId('stats-hardest-list').locator('li')).toHaveCount(2);

    await page.getByTestId('stats-category-toggle').click();
    await page.getByTestId('stats-category-option-topik-1').locator('xpath=..').click();
    const topik1 = await expectedOrder(page, {
      categories: { mode: 'any', tags: ['topik-1'] },
    });
    expect(topik1).toHaveLength(2);
    await expect.poll(() => renderedOrder(page)).toEqual(topik1);

    // #topik-2 is the Korean word not studied yet: nothing reviewed to rank.
    await page.getByTestId('stats-category-option-topik-1').locator('xpath=..').click();
    await page.getByTestId('stats-category-option-topik-2').locator('xpath=..').click();
    await expect(page.getByTestId('stats-hardest-empty')).toBeVisible();

    // Deck + category together.
    await page.getByTestId('stats-category-option-topik-2').locator('xpath=..').click();
    await page.getByTestId('stats-category-option-topik-1').locator('xpath=..').click();
    const deckValue = await page
      .getByLabel('Filter stats by deck')
      .locator('option', { hasText: KOREAN })
      .getAttribute('value');
    await page.getByLabel('Filter stats by deck').selectOption({ label: KOREAN });
    const both = await expectedOrder(page, {
      deckIds: [deckValue],
      categories: { mode: 'any', tags: ['topik-1'] },
    });
    expect(both).toEqual(topik1);
    await expect.poll(() => renderedOrder(page)).toEqual(both);
  });
});
