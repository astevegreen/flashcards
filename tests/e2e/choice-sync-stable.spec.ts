import { expect, test, type Page } from '@playwright/test';

/**
 * Review §11: a sync that lands mid-question must not rebuild a Choice card's options. Device B
 * edits the note behind one of device A's distractors and syncs; A's options stay as they were.
 */

async function enableChoiceLayout(page: Page) {
  await page.getByRole('button', { name: 'Decks' }).first().click();
  const koRow = page.locator('[data-testid^="deck-row-"]', { hasText: 'Korean Core + Hanja' });
  await koRow.getByRole('button', { name: 'Options' }).click();
  const addForm = koRow.locator('[data-testid^="add-layout-form-"]');
  await addForm.getByLabel('Answer mode').selectOption('choice');
  await addForm.getByLabel('Layout label').fill('Quiz4');
  await addForm.getByLabel('Prompt field').selectOption('word');
  await addForm.getByLabel('Answer field').selectOption('meaning');
  await addForm.locator('[data-testid^="add-layout-submit-"]').click();
  await koRow.getByRole('button', { name: 'Recognition' }).click();
  await koRow.getByRole('button', { name: 'Study' }).click();
  await expect(page.getByTestId('study-card')).toHaveAttribute('data-answer-mode', 'choice');
}

async function optionTexts(page: Page): Promise<string[]> {
  return page.getByTestId('choice-options').locator('button').allInnerTexts();
}

/** Whether this device has stored an event whose payload mentions `text`. */
async function hasStoredText(page: Page, text: string): Promise<boolean> {
  const dbName = `flashcards-db-${new URL(page.url()).searchParams.get('device')}`;
  return page.evaluate(
    async ({ name, needle }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction('events').objectStore('events').getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return JSON.stringify(rows).includes(needle);
      } finally {
        db.close();
      }
    },
    { name: dbName, needle: text },
  );
}

test('a sync mid-question keeps the Choice options as they were (§11)', async ({ browser }) => {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await pageA.goto('/?device=choicesynca');
  await pageB.goto('/?device=choicesyncb');
  await expect(pageA.getByTestId('study-card')).toBeVisible();
  await expect(pageB.getByTestId('study-card')).toBeVisible();

  await enableChoiceLayout(pageA);
  await expect(pageA.getByTestId('choice-options').locator('button')).toHaveCount(4);
  const before = await optionTexts(pageA);

  // A distractor: its text is another note's meaning, which device B now edits.
  let distractor = '';
  for (let i = 1; i <= 4; i++) {
    const option = pageA.getByTestId(`choice-option-${i}`);
    if ((await option.getAttribute('data-correct')) === 'false') {
      distractor = (await option.locator('span').last().innerText()).trim();
      break;
    }
  }
  expect(distractor).not.toBe('');

  await pageB.getByRole('button', { name: 'Words' }).first().click();
  await pageB.getByLabel('Filter by deck').selectOption({ label: 'Korean Core + Hanja' });
  await pageB.getByTestId('browse-select-all').check();
  await pageB.getByTestId('bulk-find-replace').click();
  const panel = pageB.getByTestId('find-replace-panel');
  await panel.getByTestId('find-replace-find').fill(distractor);
  await panel.getByTestId('find-replace-replace').fill('edited on B');
  await panel.getByTestId('find-replace-apply').click();
  await expect(panel.getByTestId('find-replace-message')).toContainText('Replaced');
  await pageB.getByRole('button', { name: 'Settings' }).first().click();
  await pageB.getByTestId('sync-now-btn').click();
  await expect(pageB.getByTestId('sync-status-pill')).toHaveText('Synced');

  // The edit reaches device A while its question is still open...
  await expect.poll(() => hasStoredText(pageA, 'edited on B'), { timeout: 15_000 }).toBe(true);
  // ...and the options keep their order and text. (Before the fix, every state change rebuilt
  // them, so the edited distractor's text changed here.)
  for (let i = 0; i < 10; i++) {
    expect(await optionTexts(pageA)).toEqual(before);
    await pageA.waitForTimeout(100);
  }
  await context.close();
});
