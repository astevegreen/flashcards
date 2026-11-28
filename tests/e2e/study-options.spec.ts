import { expect, test, type Page } from '@playwright/test';

/**
 * Study method and card order: the Study screen chip changes this session only (Practice never
 * touches FSRS), and Settings › Study Preferences saves the defaults for every deck.
 */

const KOREAN = 'Korean Core + Hanja';

/** Payloads of the persisted events of one type in the device's IndexedDB event log. */
async function storedPayloads(page: Page, dbName: string, type: string): Promise<unknown[]> {
  return page.evaluate(
    async ([name, eventType]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise<unknown[]>((resolve, reject) => {
          const req = db
            .transaction('events', 'readonly')
            .objectStore('events')
            .index('type')
            .getAll(eventType);
          req.onsuccess = () =>
            resolve((req.result as Array<{ payload: unknown }>).map((e) => e.payload));
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    [dbName, type] as const,
  );
}

async function openOptions(page: Page): Promise<void> {
  await page.getByTestId('study-options-btn').click();
  await expect(page.getByTestId('study-options-panel')).toBeVisible();
}

async function closeOptions(page: Page): Promise<void> {
  await page.getByTestId('study-options-done').click();
  await expect(page.getByTestId('study-options-panel')).toBeHidden();
}

test.describe('Study method and card order', () => {
  test('Practice + Random on the Study screen changes the session, never the schedule', async ({
    page,
  }) => {
    await page.goto('/?device=sopt-session');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: KOREAN });
    await expect(page.getByTestId('count-new')).toHaveText('4');
    const chip = page.getByTestId('study-options-btn');
    await expect(chip).toHaveText('SRS · Deck order');

    // Spaced repetition in random order: same cards today, nothing written.
    await openOptions(page);
    await page.getByTestId('study-order-random').check();
    await expect(chip).toHaveText('SRS · Random');
    await expect(page.getByTestId('count-new')).toHaveText('4');

    // Practice (cram) over the current deck, random order.
    await page.getByTestId('study-method-practice').check();
    await expect(page.getByTestId('study-filter-chip')).toContainText('Practice');
    await expect(chip).toHaveText('Practice · Random');
    await expect(page.getByTestId('study-order-random')).toBeChecked();
    await expect(page.getByTestId('study-order-hardest')).toBeVisible();
    await closeOptions(page);

    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await page.keyboard.press('2');
    await expect
      .poll(
        async () =>
          (await storedPayloads(page, 'flashcards-db-sopt-session', 'PracticeRecorded')).length,
      )
      .toBe(1);
    expect(await storedPayloads(page, 'flashcards-db-sopt-session', 'ReviewRecorded')).toHaveLength(
      0,
    );

    // Order changes keep the same practice session (its answer still counts).
    await openOptions(page);
    await page.getByTestId('study-order-hardest').check();
    await expect(chip).toHaveText('Practice · Hardest first');
    await expect(page.getByTestId('count-new')).toHaveText('3');

    // Back to spaced repetition: the schedule is untouched (4 new cards still due).
    await page.getByTestId('study-method-schedule').check();
    await expect(page.getByTestId('study-filter-chip')).toHaveCount(0);
    await expect(page.getByTestId('count-new')).toHaveText('4');
    await expect(page.getByTestId('study-order-hardest')).toHaveCount(0);
    await closeOptions(page);

    // Session only: switching deck resets to the saved defaults.
    await page.getByLabel('Select deck to study').selectOption({ label: 'All Decks' });
    await expect(chip).toHaveText('SRS · Deck order');
  });

  test('Settings defaults: card order applies to every deck, method opens Study in Practice', async ({
    page,
  }) => {
    const db = 'flashcards-db-sopt-settings';
    await page.goto('/?device=sopt-settings');
    await expect(page.getByTestId('study-card')).toBeVisible();
    const deckCount = (await page.getByLabel('Select deck to study').locator('option').count()) - 1;
    expect(deckCount).toBeGreaterThan(1);

    await page.getByRole('button', { name: 'Settings' }).first().click();
    const order = page.getByTestId('settings-study-order');
    await expect(order).toHaveValue('deck');
    await order.selectOption('random');
    await expect(order).toHaveValue('random');
    await expect(page.getByTestId('settings-study-order-overrides')).toHaveCount(0);

    await expect
      .poll(async () => {
        const changes = (await storedPayloads(page, db, 'DeckSettingsChanged')) as Array<{
          deck_id: string;
          settings?: { new_card_order?: string };
        }>;
        return new Set(
          changes.filter((c) => c.settings?.new_card_order === 'random').map((c) => c.deck_id),
        ).size;
      })
      .toBe(deckCount);
    const prefs = (await storedPayloads(page, db, 'PreferencesChanged')) as Array<{
      preferences: { study_order?: string };
    }>;
    expect(prefs.some((p) => p.preferences.study_order === 'random')).toBe(true);

    await page.getByTestId('settings-study-method').selectOption('practice');
    await page.getByRole('button', { name: 'Study' }).first().click();
    await expect(page.getByTestId('study-filter-chip')).toContainText('Practice');
    await expect(page.getByTestId('study-options-btn')).toHaveText('Practice · Random');

    // The saved defaults survive a reload (a new app session starts in Practice again).
    await page.reload();
    await expect(page.getByTestId('study-options-btn')).toHaveText('Practice · Random');
    expect(await storedPayloads(page, db, 'ReviewRecorded')).toHaveLength(0);

    // Ending practice with its × chip is a choice for this session: it stays on the schedule.
    await page.getByTestId('study-filter-clear').click();
    await expect(page.getByTestId('study-options-btn')).toHaveText('SRS · Random');
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('settings-study-method')).toHaveValue('practice');
    await page.getByRole('button', { name: 'Study' }).first().click();
    await expect(page.getByTestId('study-options-btn')).toHaveText('SRS · Random');
    await expect(page.getByTestId('study-filter-chip')).toHaveCount(0);
  });

  test('a deck created after choosing Random in Settings starts on Random', async ({ page }) => {
    const db = 'flashcards-db-sopt-newdeck';
    await page.goto('/?device=sopt-newdeck');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByTestId('settings-study-order').selectOption('random');
    await expect(page.getByTestId('settings-study-order')).toHaveValue('random');

    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByPlaceholder('Deck name (e.g., TOPIK II Verbs)').fill('Shuffled Verbs');
    await page.getByRole('button', { name: 'Create Deck' }).click();
    await expect(page.getByText('Created deck "Shuffled Verbs".')).toBeVisible();

    // The order is in the deck's own creation event, not a later settings change.
    await expect
      .poll(async () => {
        const created = (await storedPayloads(page, db, 'DeckCreated')) as Array<{
          name: string;
          settings?: { new_card_order?: string };
        }>;
        return created.find((d) => d.name === 'Shuffled Verbs')?.settings?.new_card_order;
      })
      .toBe('random');
  });
});
