import { expect, test, type Page } from '@playwright/test';

const KO_DECK = 'Korean Core + Hanja';

interface EventRow {
  type: string;
  payload: Record<string, unknown>;
}

async function readEvents(page: Page): Promise<EventRow[]> {
  const dbName = `flashcards-db-${new URL(page.url()).searchParams.get('device')}`;
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<EventRow[]>((resolve, reject) => {
        const req = db.transaction('events', 'readonly').objectStore('events').getAll();
        req.onsuccess = () => resolve(req.result as EventRow[]);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, dbName);
}

async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Library' }).first().click();
  await expect(page.getByTestId('deck-organization-panel')).toBeVisible();
}

function deckRow(page: Page) {
  return page.locator('[data-testid^="deck-row-"]', { hasText: KO_DECK });
}

test.describe('Deck option presets and folders', () => {
  test('a preset sets a deck’s limits and retention, a folder groups and studies its decks', async ({
    page,
  }) => {
    await page.goto('/?device=presetsfolders');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);

    // With no folders the deck list stays flat.
    await expect(page.locator('[data-testid^="folder-section-"]')).toHaveCount(0);

    await page.getByTestId('toggle-deck-organization-btn').click();
    await page.getByTestId('new-folder-name').fill('Korean study');
    await page.getByTestId('create-folder-btn').click();
    await page.getByTestId('new-preset-name').fill('Slow and steady');
    await page.getByTestId('create-preset-btn').click();
    const presetRow = page.locator('[data-testid^="preset-row-"]');
    await expect(presetRow).toHaveCount(1);
    await expect(presetRow.getByTestId(/^preset-decks-/)).toContainText('No decks use');
    const newPerDay = presetRow.getByLabel('New cards / day');
    await newPerDay.fill('2');
    await newPerDay.press('Enter');

    // Put the Korean deck in the folder and the preset.
    await deckRow(page).getByRole('button', { name: 'Options' }).click();
    await deckRow(page).getByLabel('Deck folder').selectOption({ label: 'Korean study' });
    await deckRow(page)
      .getByLabel('Deck options preset')
      .selectOption({ label: 'Preset: Slow and steady' });
    await expect(deckRow(page).getByTestId(/^deck-preset-summary-/)).toContainText('2 new cards');
    await expect(deckRow(page).getByLabel('Target retention')).toHaveCount(0);
    await expect(deckRow(page)).toContainText(/(^|\D)2 new/);
    await expect(presetRow.getByTestId(/^preset-decks-/)).toContainText(KO_DECK);

    const folderSection = page.locator('[data-testid^="folder-section-"]', {
      hasText: 'Korean study',
    });
    await expect(folderSection).toContainText(KO_DECK);
    await expect(page.getByTestId('folder-section-none')).toBeVisible();

    // The preset's retention reaches the deck as an ordinary FSRS parameters event.
    const retention = presetRow.getByLabel('Target retention (0.70–0.99)');
    await retention.fill('0.85');
    await retention.press('Enter');
    await expect
      .poll(async () => {
        const events = await readEvents(page);
        return events
          .filter((e) => e.type === 'DeckFSRSParamsChanged')
          .map((e) => (e.payload['params'] as { request_retention?: number }).request_retention);
      })
      .toContain(0.85);
    const types = new Set((await readEvents(page)).map((e) => e.type));
    for (const t of ['DeckPresetSaved', 'DeckFolderSaved', 'DeckGroupingChanged']) {
      expect(types.has(t)).toBe(true);
    }

    // Survives a reload (the events replay into the same grouping).
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);
    await expect(
      page.locator('[data-testid^="folder-section-"]', { hasText: 'Korean study' }),
    ).toContainText(KO_DECK);
    await expect(deckRow(page)).toContainText(/(^|\D)2 new/);

    // "Study folder" runs one session over the folder's decks.
    await page.locator('[data-testid^="study-folder-"]').click();
    await expect(page.getByTestId('study-filter-chip')).toContainText('Korean study');
    await expect(page.getByTestId('count-new')).toHaveText('2');

    // Leaving the preset keeps its values as the deck's own settings.
    await openLibrary(page);
    await deckRow(page).getByRole('button', { name: 'Options' }).click();
    await deckRow(page)
      .getByLabel('Deck options preset')
      .selectOption({ label: 'This deck’s own settings' });
    await expect(deckRow(page).getByLabel('Target retention')).toHaveValue('0.85');
    await expect(deckRow(page)).toContainText(/(^|\D)2 new/);
  });
});
