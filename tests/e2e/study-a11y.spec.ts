import { expect, test, type Page } from '@playwright/test';

/** Review §10: the study flow is announced, its counts are labelled, its header fits a finger. */

async function openKoreanDeck(page: Page, device: string) {
  await page.goto(`/?device=${device}`);
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
  await expect(page.getByTestId('front-field-word')).toBeVisible();
}

/** The `fields` of the newest `NoteUpserted` event this device stored. */
async function lastNoteUpsertFields(page: Page): Promise<Record<string, string>> {
  const dbName = `flashcards-db-${new URL(page.url()).searchParams.get('device')}`;
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const rows = await new Promise<{ type: string; seq: number; payload: unknown }[]>(
        (resolve, reject) => {
          const req = db.transaction('events').objectStore('events').getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        },
      );
      const upserts = rows.filter((r) => r.type === 'NoteUpserted').sort((a, b) => a.seq - b.seq);
      const last = upserts.at(-1)?.payload as { fields?: Record<string, string> } | undefined;
      return last?.fields ?? {};
    } finally {
      db.close();
    }
  }, dbName);
}

test.describe('Study accessibility (§10)', () => {
  test('announces reveal and next card, and reads the due counts with labels', async ({ page }) => {
    await openKoreanDeck(page, 'a11y-live');

    const counts = page.getByRole('group', { name: 'Due card counts' });
    await expect(counts).toHaveText(/^\d+ new,\s*\d+ learning,\s*\d+ due for review$/);
    const newCount = Number(await page.getByTestId('count-new').textContent());

    const announcer = page.getByTestId('study-announcer');
    await expect(announcer).toHaveAttribute('aria-live', 'polite');
    await expect(announcer).toHaveText(/^Next card\.\s?$/);

    await page.keyboard.press('Space');
    await expect(announcer).toHaveText(/^Answer shown/);

    // Rating moves on: "Next card." again, with the text changed so it is spoken again.
    const before = await announcer.textContent();
    await page.keyboard.press('3');
    await expect(page.getByTestId('count-new')).toHaveText(String(newCount - 1));
    await expect(announcer).toHaveText(/^Next card\.\s?$/);
    expect(await announcer.textContent()).not.toBe(before);
  });

  test('arrow keys move D-pad focus over the header instead of rating (C3)', async ({ page }) => {
    await openKoreanDeck(page, 'a11y-dpad');
    const newCount = await page.getByTestId('count-new').textContent();
    const word = await page.getByTestId('front-field-word').textContent();

    // Keyboard focus (as a D-pad gives) on a header control: arrows leave the card alone.
    const filter = page.getByTestId('study-filter-btn');
    await filter.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(filter).toBeFocused();
    for (const key of ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight']) {
      await page.keyboard.press(key);
    }
    await expect(page.getByTestId('count-new')).toHaveText(newCount ?? '');
    await expect(page.getByTestId('front-field-word')).toHaveText(word ?? '');

    // With focus back on the page, ArrowLeft rates Good as before.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('count-new')).toHaveText(String(Number(newCount) - 1));
  });

  test('a note edit sends only the field that changed', async ({ page }) => {
    await openKoreanDeck(page, 'a11y-edit');
    await page.keyboard.press('e');
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await dialog.locator('textarea').last().fill('Edited only here');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    await expect
      .poll(async () => Object.values(await lastNoteUpsertFields(page)))
      .toEqual(['Edited only here']);
  });
});

test.describe('Study header on a touch screen (§10)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('header controls are at least 44 px tall', async ({ page }) => {
    await openKoreanDeck(page, 'a11y-touch');
    const controls = [
      page.getByLabel('Select deck to study'),
      page.getByTestId('study-filter-btn'),
      page.getByRole('button', { name: 'Undo', exact: true }),
      page.getByRole('button', { name: 'Edit', exact: true }),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});
