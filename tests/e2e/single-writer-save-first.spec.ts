import { expect, test, type Page } from '@playwright/test';
import { rateOne, storedEvents } from './helpers/writer-tabs.ts';

/**
 * "Use here instead" while a rating is still being saved: the writer tab saves its queued writes
 * before it hands over. This covers the shell's link from the app's persist queue to the handoff
 * (`exposeWhenSaved` → `whenSaved` in `apps/web/src/main.tsx`); without it, the second rating is
 * still queued when writes are blocked, and is lost.
 */

const DEVICE = 'savefirst';
const DB = `flashcards-db-${DEVICE}`;

/** Holds a read-write transaction on the events store until `releaseHold()`: writes queue behind it. */
async function holdEventWrites(page: Page): Promise<void> {
  await page.evaluate(
    (name) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const w = window as unknown as { releaseHold?: () => void };
          let held = true;
          w.releaseHold = () => {
            held = false;
          };
          const store = db.transaction('events', 'readwrite').objectStore('events');
          // Keeps the transaction alive with one request after another.
          const spin = () => {
            if (held) store.count().onsuccess = spin;
            else db.close();
          };
          spin();
          resolve();
        };
      }),
    DB,
  );
}

test('"Use here instead" waits for ratings still being saved, then hands over', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await first.goto(`/?device=${DEVICE}`);
  await expect(first.getByTestId('study-card')).toBeVisible();
  const newAtStart = Number(await first.getByTestId('count-new').textContent());
  const eventsAtStart = await storedEvents(first, DB);

  const second = await context.newPage();
  await second.goto(`/?device=${DEVICE}`);
  const screen = second.getByTestId('other-tab');
  await expect(screen).toBeVisible();

  // One slow write: the first rating waits on IndexedDB, the second waits in the persist queue.
  await holdEventWrites(first);
  await rateOne(first);
  await rateOne(first);

  await screen.getByRole('button', { name: 'Use here instead' }).click();
  // The writer is still saving: it hands over only after both ratings land.
  await second.waitForTimeout(1000); // NOSONAR (S2925): the write stays slow for a timed window
  await expect(second.getByTestId('other-tab')).toBeVisible();
  await first.evaluate(() => (window as unknown as { releaseHold: () => void }).releaseHold());

  await expect(second.getByTestId('study-card')).toBeVisible();
  await expect(second.getByTestId('count-new')).toHaveText(String(newAtStart - 2));
  await expect(first.getByTestId('other-tab')).toBeVisible();
  expect(await storedEvents(second, DB)).toBeGreaterThanOrEqual(eventsAtStart + 2);

  await context.close();
});
