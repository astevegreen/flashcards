import { expect, type Page } from '@playwright/test';

/** Number of events stored in database `db`, read straight from IndexedDB. */
export async function storedEvents(page: Page, db: string): Promise<number> {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const opened = open.result;
          const count = opened.transaction('events').objectStore('events').count();
          count.onsuccess = () => {
            opened.close();
            resolve(count.result);
          };
        };
      }),
    db,
  );
}

/** Flips the current card, rates it Easy and waits for the new-card count to drop. */
export async function rateOne(page: Page): Promise<void> {
  const before = Number(await page.getByTestId('count-new').textContent());
  await page.keyboard.press('Space');
  await page.getByTestId('rate-easy').click();
  await expect(page.getByTestId('count-new')).toHaveText(String(before - 1));
}
