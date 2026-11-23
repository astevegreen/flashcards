import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/anki/${name}`, import.meta.url));

const ANKI_DECK = 'Japanese::Vocab';

async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Library' }).first().click();
  await expect(page.locator('h1', { hasText: 'Library' })).toBeVisible();
}

async function chooseApkg(page: Page, name: string): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('anki-pick-file-btn').click(),
  ]);
  await chooser.setFiles(fixture(name));
}

/** Picks a package, waits for the pre-import summary, then presses Import. */
async function pickApkg(page: Page, name: string): Promise<void> {
  await chooseApkg(page, name);
  const status = page.getByTestId('anki-import-status');
  await expect(status).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });
  await expect(status).toContainText('Ready to import');
  await page.getByTestId('anki-import-btn').click();
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

    // Unsafe or wrong packages are refused while reading, before any summary.
    await chooseApkg(page, 'malicious-traversal.apkg');
    await expect(status).toHaveAttribute('data-phase', 'error', { timeout: 30_000 });
    await expect(status).toContainText('Unsafe Anki package');
    await expect(page.getByTestId('anki-import-btn')).toBeDisabled();

    await chooseApkg(page, 'not-anki.apkg');
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

test.describe('Phase 14 Anki follow-ups', () => {
  test('the summary lists each field language and a change applies to the note type and deck', async ({
    page,
  }) => {
    await page.goto('/?device=p14ankilang');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);
    await page.getByTestId('import-anki-btn').click();
    await pickApkg(page, 'basic-reversed.apkg');
    await expect(page.getByTestId('anki-import-status')).toHaveAttribute('data-phase', 'done', {
      timeout: 30_000,
    });

    const editor = page.getByTestId('anki-field-languages');
    await expect(editor).toContainText('Basic (and reversed card)');
    const front = page.getByLabel('Language of Front (Basic (and reversed card))');
    const back = page.getByLabel('Language of Back (Basic (and reversed card))');
    await expect(front).toHaveValue('zh-Hans');
    await expect(back).toHaveValue('en');

    const deckRow = page.locator('[data-testid^="deck-row-"]', { hasText: ANKI_DECK });
    await expect(deckRow.getByText('zh-Hans', { exact: true })).toBeVisible();
    // Han-only text was guessed as Chinese; this deck is Japanese.
    await front.selectOption('ja');
    await expect(front).toHaveValue('ja');
    await expect(deckRow.getByText('ja', { exact: true })).toBeVisible();
    // The back field is not the deck's language field: only the note type changes.
    await back.selectOption('ko');
    await expect(back).toHaveValue('ko');
    await expect(deckRow.getByText('ja', { exact: true })).toBeVisible();

    // A re-import keeps the corrections.
    await pickApkg(page, 'basic-reversed.apkg');
    await expect(page.getByTestId('anki-import-status')).toContainText('(0 new)', {
      timeout: 30_000,
    });
    await expect(front).toHaveValue('ja');
    await expect(back).toHaveValue('ko');
  });

  test('cards suspended in Anki arrive suspended; buried ones do not', async ({ page }) => {
    await page.goto('/?device=p14ankisusp');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);
    await page.getByTestId('import-anki-btn').click();
    await pickApkg(page, 'suspended.apkg');
    const status = page.getByTestId('anki-import-status');
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(status).toContainText('Suspended 2 cards, as in Anki.');

    await page.getByRole('button', { name: 'Browse' }).first().click();
    const row = (text: string) => page.locator('[data-testid^="browse-row-"]', { hasText: text });
    await expect(row('사과').getByTestId('browse-suspended-badge')).toHaveText('1 suspended');
    await expect(row('포도').getByTestId('browse-suspended-badge')).toHaveText('1 suspended');
    await expect(row('바나나')).toBeVisible();
    await expect(row('바나나').getByTestId('browse-suspended-badge')).toHaveCount(0);

    // Study: 3 notes, and the two suspended cards are left out of the new queue.
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean::Fruit' });
    await expect(page.getByTestId('count-new')).toHaveText('3');
  });

  test('every image of a field is kept, and kana: fields show readings only', async ({ page }) => {
    await page.goto('/?device=p14ankimedia');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);
    await page.getByTestId('import-anki-btn').click();
    const status = page.getByTestId('anki-import-status');

    await pickApkg(page, 'multi-media.apkg');
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(status).toContainText('4 media files');
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean::Media' });
    const card = page.getByTestId('study-card');
    await expect(card).toContainText('사과');
    await expect(card.locator('img')).toHaveCount(2);

    await openLibrary(page);
    await page.getByTestId('import-anki-btn').click();
    await pickApkg(page, 'kana.apkg');
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    // Wide enough for the Browse detail pane, which lists every field of the note.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: 'Browse' }).first().click();
    const row = page.locator('[data-testid^="browse-row-"]', { hasText: '日本語' });
    await row.locator('[data-testid^="browse-show-"]').click();
    const detail = page.getByTestId('browse-detail');
    // Browse shows the full ruby the import kept (the kana:/kanji: reduction is a per-layout flag).
    await expect(detail.getByTestId('browse-detail-headline')).toContainText('日本語');
    await expect(detail).toContainText('にほんご');
    await expect(detail).not.toContainText('[');
  });
});

test.describe('Phase 12 Anki import panel layout stability', () => {
  // Block the service worker so context.route can hold the lazy panel chunk.
  test.use({ serviceWorkers: 'block' });

  for (const width of [320, 390]) {
    test(`keeps one fixed box at ${width}px wide: fallback, idle, done with warnings, error`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/?device=p12layout${width}`);
      await expect(page.getByTestId('study-card')).toBeVisible();

      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await context.route('**/AnkiImportPanel-*.js', async (route) => {
        await held;
        await route.continue();
      });

      await openLibrary(page);
      await page.getByTestId('import-anki-btn').click();
      const region = page.locator('#anki-import-region');
      const size = async () => {
        const box = await region.boundingBox();
        return box && { width: box.width, height: box.height };
      };

      await expect(page.getByTestId('anki-import-loading')).toBeVisible();
      const fallback = await size();
      expect(fallback?.height).toBeGreaterThan(0);

      release();
      const status = page.getByTestId('anki-import-status');
      await expect(status).toHaveAttribute('data-phase', 'idle');
      expect(await size()).toEqual(fallback);
      // The heading, description and controls fit, leaving room for the status text.
      const area = await page.getByTestId('anki-import-status-area').boundingBox();
      expect(area?.height ?? 0).toBeGreaterThanOrEqual(64);

      await pickApkg(page, 'media.apkg');
      await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
      await expect(page.getByTestId('anki-import-warnings')).toBeAttached();
      expect(await size()).toEqual(fallback);

      await chooseApkg(page, 'newer-format.apkg');
      await expect(status).toHaveAttribute('data-phase', 'error', { timeout: 30_000 });
      expect(await size()).toEqual(fallback);

      await context.unroute('**/AnkiImportPanel-*.js');
    });
  }
});
