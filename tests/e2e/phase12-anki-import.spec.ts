import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/anki/${name}`, import.meta.url));

const ANKI_DECK = 'Japanese::Vocab';

async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Library' }).first().click();
  await expect(page.locator('h1', { hasText: 'Library' })).toBeVisible();
}

async function pickApkg(page: Page, name: string): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('anki-pick-file-btn').click(),
  ]);
  await chooser.setFiles(fixture(name));
}

test.describe('Phase 12 Anki .apkg import', () => {
  test('imports an .apkg from Library, shows the notes in Browse, and studies a card', async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on('request', (req) => requested.push(req.url()));

    await page.goto('/?device=p12anki');
    await expect(page.getByTestId('study-card')).toBeVisible();

    await openLibrary(page);
    // The SQLite WASM is not fetched until someone actually imports.
    expect(requested.some((url) => url.includes('sql-wasm'))).toBe(false);

    await page.getByTestId('import-anki-btn').click();
    const panel = page.getByTestId('anki-import-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('anki-include-history')).not.toBeChecked();

    await pickApkg(page, 'basic-reversed.apkg');
    const status = page.getByTestId('anki-import-status');
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(status).toContainText('Imported 2 notes into 1 deck (1 new)');
    expect(await status.textContent()).not.toContain('Review history');

    // The WASM came from this origin.
    const origin = new URL(page.url()).origin;
    const wasm = requested.filter((url) => url.includes('sql-wasm'));
    expect(wasm.length).toBeGreaterThan(0);
    expect(wasm.every((url) => url.startsWith(origin))).toBe(true);

    // Library lists the deck; Browse shows both notes as plain text (no <b> markup).
    await expect(page.locator('[data-testid^="deck-row-"]', { hasText: ANKI_DECK })).toBeVisible();
    await page.getByRole('button', { name: 'Browse' }).first().click();
    const list = page.getByTestId('browse-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText('犬');
    await expect(list).toContainText('猫');
    await expect(list).not.toContainText('<b>');

    // Study one card of the imported deck: 2 notes x 2 templates = 4 new cards, one per note today
    // (the queue holds at most one card per note).
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: ANKI_DECK });
    await expect(page.getByTestId('count-new')).toHaveText('2');
    await expect(page.getByTestId('study-card')).toContainText(/犬|猫|dog|cat/);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('rate-good')).toBeVisible();
    await page.getByTestId('rate-good').click();
    await expect(page.getByTestId('count-new')).not.toHaveText('2');
  });

  test('re-importing the same package changes nothing; unsafe packages are refused', async ({
    page,
  }) => {
    await page.goto('/?device=p12ankiagain');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);
    await page.getByTestId('import-anki-btn').click();

    const status = page.getByTestId('anki-import-status');
    await pickApkg(page, 'basic-reversed.apkg');
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await pickApkg(page, 'basic-reversed.apkg');
    await expect(status).toContainText('(0 new): 0 added or updated', { timeout: 30_000 });

    await pickApkg(page, 'malicious-traversal.apkg');
    await expect(status).toHaveAttribute('data-phase', 'error', { timeout: 30_000 });
    await expect(status).toContainText('Unsafe Anki package');

    await pickApkg(page, 'not-anki.apkg');
    await expect(status).toContainText('does not contain an Anki collection', { timeout: 30_000 });
  });

  test('reads a current-Anki (anki21b, zstd) package and opt-in review history', async ({
    page,
  }) => {
    await page.goto('/?device=p12anki21b');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);
    await page.getByTestId('import-anki-btn').click();
    const status = page.getByTestId('anki-import-status');

    await pickApkg(page, 'anki21b.apkg');
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(status).toContainText('1 media file');
    await expect(
      page.locator('[data-testid^="deck-row-"]', { hasText: 'Korean::Greetings' }),
    ).toBeVisible();

    await page.getByTestId('anki-include-history').check();
    await pickApkg(page, 'review-history.apkg');
    await expect(status).toContainText('Review history: 6 reviews imported.', { timeout: 30_000 });
    await expect(status).toContainText('2 manual/rescheduled, 1 filtered-deck (cram)');
  });
});
