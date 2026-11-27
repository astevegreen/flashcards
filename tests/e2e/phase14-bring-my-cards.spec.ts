import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
} from '../../packages/core/src/events/replay.ts';
import { createHlcState } from '../../packages/core/src/hlc.ts';
import { deriveNoteId } from '../../packages/core/src/ids.ts';
import { exportFlashpkg } from '../../packages/core/src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../../packages/core/src/model/presets.ts';

const fixture = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const CP949_CSV = Buffer.from([
  0xb4, 0xdc, 0xbe, 0xee, 0x2c, 0xb6, 0xe6, 0x0d, 0x0a, 0xb0, 0xed, 0xbe, 0xe7, 0xc0, 0xcc, 0x2c,
  0x63, 0x61, 0x74, 0x0d, 0x0a,
]);

function buildFlashpkg(): Buffer {
  const st = createEmptyState();
  const factory = createEventFactory('pkg-author', 0, createHlcState('pkg-author', 1000));
  const deckId = 'bring-ko-deck';
  applyEvents(st, [
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: 'Bring Korean Pack',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: 1000,
      },
      1000,
    ),
    factory.create(
      'NoteUpserted',
      {
        note_id: deriveNoteId(deckId, 'n1'),
        deck_id: deckId,
        source_key: 'n1',
        fields: { word: '사과', meaning: 'apple' },
        provenance: { source: 'import', reviewed: true },
        created_order: 0,
      },
      1001,
    ),
  ]);
  return Buffer.from(
    exportFlashpkg(st, { packageId: 'pkg:bring-ko', name: 'Bring Korean Pack', version: '1.0.0' }),
  );
}

async function openBringMyCards(page: Page, device: string): Promise<void> {
  await page.goto(`/?device=${device}`);
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByRole('button', { name: 'Decks' }).first().click();
  await expect(page.locator('h1', { hasText: 'Decks' })).toBeVisible();
  await page.getByTestId('import-export-btn').click();
  await expect(page.getByTestId('bring-my-cards-panel')).toBeVisible();
}

type FileInput = string | { name: string; mimeType: string; buffer: Buffer };

async function pick(page: Page, file: FileInput): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('bring-pick-file-btn').click(),
  ]);
  await chooser.setFiles(file);
}

async function startOver(page: Page): Promise<void> {
  await page.getByTestId('bring-start-over-btn').click();
  await expect(page.getByTestId('bring-route')).toHaveAttribute('data-kind', 'input');
}

const route = (page: Page) => page.getByTestId('bring-route');

/** The Anki route stops at a summary; Import imports. */
async function confirmAnki(page: Page): Promise<void> {
  const status = page.getByTestId('anki-import-status');
  await expect(status).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });
  await page.getByTestId('anki-import-btn').click();
}

const deckRow = (page: Page, name: string) =>
  page.locator('[data-testid^="deck-row-"]', { hasText: name });

const columnTarget = (page: Page, index: number) => page.getByTestId(`bring-map-col-${index}`);

test.describe('Phase 14 Bring my cards: format detection routes to the existing importers', () => {
  test('Anki .apkg (legacy and anki21b) goes to the Anki importer, history off', async ({
    page,
  }) => {
    await openBringMyCards(page, 'p14bringanki');

    await pick(page, fixture('anki/basic-reversed.apkg'));
    await expect(route(page)).toHaveAttribute('data-kind', 'anki');
    const status = page.getByTestId('anki-import-status');
    // A summary first: nothing is imported until Import is pressed.
    await expect(status).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });
    await expect(status).toContainText('Ready to import 2 notes into 1 deck (1 new)');
    await expect(status).toContainText('Decks: Japanese::Vocab (new).');
    await expect(page.getByTestId('bring-start-over-btn')).toBeEnabled();
    await expect(deckRow(page, 'Japanese::Vocab')).toHaveCount(0);
    await page.getByTestId('anki-import-btn').click();
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(status).toContainText('Imported 2 notes into 1 deck (1 new)');
    await expect(page.getByTestId('anki-include-history')).not.toBeChecked();
    await expect(page.getByTestId('anki-field-languages')).toBeVisible();
    await expect(
      page.locator('[data-testid^="deck-row-"]', { hasText: 'Japanese::Vocab' }),
    ).toBeVisible();

    // Anki 2.1 legacy export: collection.anki21 beside a stub collection.anki2.
    await startOver(page);
    await pick(page, fixture('anki/cloze.apkg'));
    await expect(route(page)).toHaveAttribute('data-kind', 'anki');
    await confirmAnki(page);
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(
      page.locator('[data-testid^="deck-row-"]', { hasText: 'Geography' }),
    ).toBeVisible();

    await startOver(page);
    await pick(page, fixture('anki/anki21b.apkg'));
    await expect(route(page)).toHaveAttribute('data-kind', 'anki');
    await confirmAnki(page);
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(
      page.locator('[data-testid^="deck-row-"]', { hasText: 'Korean::Greetings' }),
    ).toBeVisible();
  });

  test('a Flashcards Deluxe export goes to the CSV importer with a new deck', async ({ page }) => {
    await openBringMyCards(page, 'p14bringfd');

    await pick(page, fixture('bring/flashcards-deluxe.txt'));
    await expect(route(page)).toHaveAttribute('data-kind', 'csv');
    await expect(page.getByTestId('bring-csv-form')).toContainText('Flashcards Deluxe file');
    await expect(columnTarget(page, 0)).toHaveAttribute('data-target', 'field:word');
    await expect(page.getByTestId('bring-map-target-0')).toHaveValue('field:word');
    await expect(page.getByTestId('bring-csv-deck-name')).toHaveValue('flashcards-deluxe');

    await page.getByTestId('bring-csv-deck-name').fill('FD Korean');
    await page.getByTestId('bring-csv-import-btn').click();
    const status = page.getByTestId('bring-csv-status');
    await expect(status).toHaveAttribute('data-phase', 'done');
    await expect(status).toContainText('Imported 2 note(s) into "FD Korean"');
    await expect(page.getByTestId('bring-csv-import-btn')).toBeDisabled();
    await expect(
      page.locator('[data-testid^="deck-row-"]', { hasText: 'FD Korean' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Words' }).first().click();
    await page.getByLabel('Search notes by text or tag').fill('puppy');
    await expect(page.getByTestId('browse-list')).toContainText('강아지');
  });

  test('a dropped CSV file is detected the same way as a picked one', async ({ page }) => {
    await openBringMyCards(page, 'p14bringdrop');
    await page.getByTestId('bring-drop-zone').evaluate((zone) => {
      const data = new DataTransfer();
      data.items.add(new File(['Word,Meaning\n바다,sea\n'], 'sea.csv', { type: 'text/csv' }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
    });
    await expect(route(page)).toHaveAttribute('data-kind', 'csv');
    await expect(page.getByTestId('bring-csv-form')).toContainText('CSV/TSV table');
    await expect(page.getByTestId('bring-csv-deck-name')).toHaveValue('sea');
  });

  test('a picked or dropped file that cannot be read says so (C25)', async ({ page }) => {
    await openBringMyCards(page, 'p14bringunreadable');
    // The file moved or lost permission between choosing it and reading it.
    await page.evaluate(() => {
      File.prototype.arrayBuffer = () =>
        Promise.reject(new DOMException('The file could not be read.', 'NotReadableError'));
    });
    const status = page.getByTestId('bring-status');
    await pick(page, { name: 'gone.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b') });
    await expect(route(page)).toHaveAttribute('data-kind', 'input');
    await expect(status).toContainText('Could not read that file: The file could not be read.');

    // Another message first, so the drop's own message is what the next check sees.
    await page.getByTestId('bring-link-input').fill('https://example.com/cards.csv');
    await page.getByTestId('bring-link-submit').click();
    await expect(status).toContainText("isn't a Google Sheets link");
    await page.getByTestId('bring-drop-zone').evaluate((zone) => {
      const data = new DataTransfer();
      data.items.add(new File(['x,y'], 'dropped.csv', { type: 'text/csv' }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
    });
    await expect(status).toContainText('Could not read that file');
    await expect(page.getByTestId('bring-drop-zone')).toBeVisible();
  });

  test('.flashpkg (even named .zip) goes to the .flashpkg importer', async ({ page }) => {
    await openBringMyCards(page, 'p14bringpkg');
    await pick(page, { name: 'backup.zip', mimeType: 'application/zip', buffer: buildFlashpkg() });
    await expect(route(page)).toHaveAttribute('data-kind', 'flashpkg');
    const status = page.getByTestId('bring-flashpkg-status');
    await expect(status).toHaveAttribute('data-phase', 'done');
    await expect(status).toContainText('Imported "Bring Korean Pack" (1 deck(s), 1 note(s)');
    await expect(
      page.locator('[data-testid^="deck-row-"]', { hasText: 'Bring Korean Pack' }),
    ).toBeVisible();
  });

  test('unsupported input gets a clear message and keeps the drop zone', async ({ page }) => {
    await openBringMyCards(page, 'p14bringbad');
    const status = page.getByTestId('bring-status');

    await pick(page, fixture('anki/not-anki.apkg'));
    await expect(route(page)).toHaveAttribute('data-kind', 'input');
    await expect(status).toContainText('named like an Anki package');

    await pick(page, { name: 'photo.png', mimeType: 'image/png', buffer: PNG_MAGIC });
    await expect(status).toContainText("isn't a format this app can import");

    // A Korean Excel CSV saved as CP949 (단어,뜻 / 고양이,cat) gets a "save as UTF-8" hint.
    await pick(page, { name: 'cards.csv', mimeType: 'text/csv', buffer: CP949_CSV });
    await expect(route(page)).toHaveAttribute('data-kind', 'input');
    await expect(status).toContainText('CSV UTF-8');

    await page.getByTestId('bring-link-input').fill('https://example.com/cards.csv');
    await page.getByTestId('bring-link-submit').click();
    await expect(status).toContainText("isn't a Google Sheets link");

    await page
      .getByTestId('bring-link-input')
      .fill('https://docs.google.com/document/d/abcdefghij1234567890/edit');
    await page.getByTestId('bring-link-submit').click();
    await expect(status).toContainText('This is a Google Doc');
    await expect(page.getByTestId('bring-drop-zone')).toBeVisible();
  });

  test('a pasted Google Sheets link links the Sheet as a source (mocked Google)', async ({
    page,
  }) => {
    const SHEET_ID = 'mockBringSheet303';
    // The rows are held until the test has seen that "Start over" is locked while linking.
    let releaseRows: () => void = () => {};
    const rowsHeld = new Promise<void>((resolve) => {
      releaseRows = resolve;
    });
    await page.route('https://sheets.googleapis.com/v4/spreadsheets/**', async (r) => {
      const url = r.request().url();
      if (url.includes('/values/')) {
        await rowsHeld;
        await r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            // A view-only Sheet that already carries Card IDs (no write-back needed).
            values: [
              ['Word', 'Meaning', 'Tags', 'Card ID'],
              ['나무', 'tree', 'nature', 'card-tree-01'],
              ['하늘', 'sky', 'nature', 'card-sky-02'],
            ],
          }),
        });
        return;
      }
      if (url.includes('fields=spreadsheetId')) {
        await r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            spreadsheetId: SHEET_ID,
            properties: { title: 'Nature Words Sheet' },
            sheets: [{ properties: { title: 'Cards' } }],
          }),
        });
        return;
      }
      await r.fulfill({ status: 404, body: 'Not found' });
    });
    await page.route('https://www.googleapis.com/drive/v3/files/**', async (r) => {
      if (r.request().url().includes(`/${SHEET_ID}?`)) {
        await r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: SHEET_ID,
            name: 'Nature Words Sheet',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            modifiedTime: '2026-11-22T10:00:00Z',
            capabilities: { canEdit: false },
          }),
        });
        return;
      }
      await r.fulfill({ status: 404, body: 'Not found' });
    });

    const device = 'p14bringsheet';
    await page.goto(`/?device=${device}`);
    await expect(page.getByTestId('study-card')).toBeVisible();
    // A valid Google token in IndexedDB, as sources.spec.ts does, so the real Sheets client runs.
    await page.evaluate(async (dbName) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({
          key: 'oauth_tokens',
          value: {
            accessToken: 'mock-google-token',
            refreshToken: 'mock-refresh-token',
            expiresAt: Date.now() + 3600_000,
            scope:
              'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file',
            reconnectRequired: false,
          },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, `flashcards-db-${device}`);
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByTestId('import-export-btn').click();

    await page
      .getByTestId('bring-link-input')
      .fill(`https://docs.google.com/spreadsheets/u/0/d/${SHEET_ID}/edit#gid=0`);
    await page.getByTestId('bring-link-submit').click();
    await expect(route(page)).toHaveAttribute('data-kind', 'google-sheets');
    await expect(page.getByTestId('bring-sheets')).toContainText(
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
    );

    const read = page.getByTestId('bring-sheets-read-btn');
    await expect(read).toBeEnabled();
    await read.click();
    const status = page.getByTestId('bring-sheets-status');
    await expect(status).toHaveAttribute('data-phase', 'reading');
    await expect(page.getByTestId('bring-start-over-btn')).toBeDisabled();
    releaseRows();
    await expect(status).toHaveAttribute('data-phase', 'mapping');
    await expect(page.getByTestId('bring-start-over-btn')).toBeEnabled();
    await expect(page.getByTestId('bring-sheets')).toContainText('Nature Words Sheet');
    // A Sheet always has a header row (Card IDs are written under it): no switch is offered.
    await expect(page.getByTestId('bring-map-header-row')).toHaveCount(0);
    await expect(columnTarget(page, 0)).toHaveAttribute('data-target', 'field:word');
    await expect(columnTarget(page, 2)).toHaveAttribute('data-target', 'tags');
    await expect(columnTarget(page, 3)).toHaveAttribute('data-target', 'card_id');
    await page.getByTestId('bring-sheets-link-btn').click();
    await expect(status).toHaveAttribute('data-phase', 'done');
    await expect(page.getByTestId('bring-start-over-btn')).toBeEnabled();
    await expect(status).toContainText('Linked 1 Google file(s): 2 note(s)');
    await expect(page.getByTestId(`source-row-${SHEET_ID}`)).toBeVisible();
    await expect(
      page.locator('[data-testid^="deck-row-"]', { hasText: 'Nature Words Sheet' }),
    ).toBeVisible();
  });
});

test.describe('Phase 14 Bring my cards layout stability', () => {
  // Block the service worker so context.route can hold the lazy panel chunk.
  test.use({ serviceWorkers: 'block' });

  for (const width of [320, 390]) {
    test(`keeps one fixed box at ${width}px wide: fallback, input, routes, results`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/?device=p14bringlayout${width}`);
      await expect(page.getByTestId('study-card')).toBeVisible();

      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await context.route('**/BringMyCardsPanel-*.js', async (r) => {
        await held;
        await r.continue();
      });

      await page.getByRole('button', { name: 'Decks' }).first().click();
      await page.getByTestId('import-export-btn').click();
      const region = page.locator('#import-export-region');
      const size = async () => {
        const box = await region.boundingBox();
        return box && { width: box.width, height: box.height };
      };
      await expect(page.getByTestId('bring-my-cards-loading')).toBeVisible();
      const fallback = await size();
      expect(fallback?.height).toBeGreaterThan(0);

      release();
      await expect(page.getByTestId('bring-drop-zone')).toBeVisible();
      expect(await size()).toEqual(fallback);
      // The whole input view fits without scrolling sideways.
      const noSideScroll = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(noSideScroll).toBe(true);

      await pick(page, fixture('anki/not-anki.apkg'));
      await expect(page.getByTestId('bring-status')).toContainText('named like an Anki package');
      expect(await size()).toEqual(fallback);

      await pick(page, fixture('bring/flashcards-deluxe.txt'));
      await expect(route(page)).toHaveAttribute('data-kind', 'csv');
      await expect(page.getByTestId('bring-mapping')).toBeVisible();
      expect(await size()).toEqual(fallback);
      // The column cards wrap inside the panel instead of pushing the page sideways.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await startOver(page);

      await pick(page, fixture('anki/media.apkg'));
      await confirmAnki(page);
      expect(await size()).toEqual(fallback);
      await expect(page.getByTestId('anki-import-status')).toHaveAttribute('data-phase', 'done', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('anki-field-languages')).toBeAttached();
      expect(await size()).toEqual(fallback);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);

      await context.unroute('**/BringMyCardsPanel-*.js');
    });
  }
});

test.describe('Bring my cards column mapping', () => {
  const OWNER_CSV = [
    'word,definition,example,category1,category2,category3,source',
    '나무,tree,나무가 커요.,nature,A1,noun,textbook',
    '먹다,to eat,밥을 먹어요.,food,A1,verb,',
  ].join('\n');

  test('maps word / definition / example / category columns, and the user can change any', async ({
    page,
  }) => {
    await openBringMyCards(page, 'pmapowner');
    await page.getByTestId('bring-drop-zone').evaluate((zone, text) => {
      const data = new DataTransfer();
      data.items.add(new File([text], 'my words.csv', { type: 'text/csv' }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
    }, OWNER_CSV);
    await expect(route(page)).toHaveAttribute('data-kind', 'csv');
    await expect(page.getByTestId('bring-csv-note-type')).toHaveValue('preset:vocab-ko');
    await expect(page.getByTestId('bring-csv-rows')).toHaveText('2 rows');
    await expect(page.getByTestId('bring-map-header-row')).toBeChecked();

    const expected = ['field:word', 'field:meaning', 'field:example', 'tags', 'tags', 'tags'];
    for (const [i, target] of expected.entries()) {
      await expect(columnTarget(page, i)).toHaveAttribute('data-target', target);
    }
    // An unknown column is kept as a Notes line, not dropped.
    await expect(columnTarget(page, 6)).toHaveAttribute('data-target', 'notes');
    const preview = page.getByTestId('bring-map-preview');
    await expect(preview).toContainText('Meaning: tree');
    await expect(preview).toContainText('Tags: nature, A1, noun');
    await expect(preview).toContainText('Notes: source: textbook');

    // Without a column for the front, Import is blocked and says why.
    const importBtn = page.getByTestId('bring-csv-import-btn');
    await page.getByTestId('bring-map-target-0').selectOption('ignore');
    await expect(page.getByTestId('bring-map-problems')).toContainText('Choose a column for Word');
    await expect(importBtn).toBeDisabled();
    await page.getByTestId('bring-map-target-0').selectOption('field:word');
    await expect(page.getByTestId('bring-map-problems')).toHaveCount(0);

    // The user's change wins: the source column is not imported.
    await page.getByTestId('bring-map-target-6').selectOption('ignore');
    await expect(columnTarget(page, 6)).toContainText('Your choice');
    await expect(preview).not.toContainText('textbook');

    await importBtn.click();
    const status = page.getByTestId('bring-csv-status');
    await expect(status).toHaveAttribute('data-phase', 'done');
    await expect(status).toContainText('Imported 2 note(s) into "my words"');
    await expect(deckRow(page, 'my words')).toBeVisible();

    await page.getByRole('button', { name: 'Words' }).first().click();
    const search = page.getByLabel('Search notes by text or tag');
    await search.fill('#noun');
    await expect(page.getByTestId('browse-list')).toContainText('나무');
    await expect(page.getByTestId('browse-list')).not.toContainText('먹다');
    await search.fill('to eat');
    await expect(page.getByTestId('browse-list')).toContainText('먹다');
  });

  test('the preview keeps quoted padding and quoted spaces, as the import does', async ({
    page,
  }) => {
    await openBringMyCards(page, 'pmapquotes');
    const csv = 'word,meaning\n나무, " tree "\n하늘,"   "\n바다,  sea  \n';
    await page.getByTestId('bring-drop-zone').evaluate((zone, text) => {
      const data = new DataTransfer();
      data.items.add(new File([text], 'quoted.csv', { type: 'text/csv' }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
    }, csv);
    await expect(route(page)).toHaveAttribute('data-kind', 'csv');
    const preview = page.getByTestId('bring-map-preview');
    await expect(preview.locator('li')).toHaveCount(3);
    // Playwright's text matchers collapse spaces, so read the raw text.
    const rows = await preview
      .locator('li')
      .evaluateAll((items) =>
        items.map((li) => [...li.querySelectorAll('p')].map((p) => p.textContent)),
      );
    expect(rows).toEqual([
      ['Word: 나무', 'Meaning:  tree '],
      // The preview shows a run of spaces as one; the field is there, not dropped.
      ['Word: 하늘', 'Meaning:  '],
      ['Word: 바다', 'Meaning: sea'],
    ]);
    await page.getByTestId('bring-csv-import-btn').click();
    await expect(page.getByTestId('bring-csv-status')).toContainText(
      'Imported 3 note(s) into "quoted"',
    );
  });

  test('pasted rows with no header row import every row', async ({ page }) => {
    await openBringMyCards(page, 'pmappaste');
    await page.getByTestId('bring-link-input').fill('나무\ttree\n하늘\tsky\n바다\tsea');
    await page.getByTestId('bring-link-submit').click();
    await expect(route(page)).toHaveAttribute('data-kind', 'csv');
    await expect(page.getByTestId('bring-csv-form')).toContainText('Pasted rows');
    // Row 1 looks like the Korean rows under it, so it is read as a card.
    await expect(page.getByTestId('bring-map-header-row')).not.toBeChecked();
    await expect(page.getByTestId('bring-csv-rows')).toHaveText('3 rows');
    await expect(columnTarget(page, 0)).toContainText('Column 1');
    await expect(columnTarget(page, 0)).toHaveAttribute('data-target', 'field:word');
    await expect(columnTarget(page, 1)).toHaveAttribute('data-target', 'field:meaning');

    await page.getByTestId('bring-csv-deck-name').fill('Pasted Nature');
    await page.getByTestId('bring-csv-import-btn').click();
    await expect(page.getByTestId('bring-csv-status')).toContainText(
      'Imported 3 note(s) into "Pasted Nature"',
    );
  });

  test('an Excel workbook goes through the same mapping step', async ({ page }) => {
    await openBringMyCards(page, 'pmapxlsx');
    // 단어 / 뜻 / 예문 / 주제 with two rows (see tests/fixtures/bring/README.md).
    await pick(page, fixture('bring/korean-words.xlsx'));
    await expect(route(page)).toHaveAttribute('data-kind', 'csv');
    await expect(page.getByTestId('bring-csv-form')).toContainText('Excel workbook');
    for (const [i, target] of ['field:word', 'field:meaning', 'field:example', 'tags'].entries()) {
      await expect(columnTarget(page, i)).toHaveAttribute('data-target', target);
    }
    await page.getByTestId('bring-csv-import-btn').click();
    await expect(page.getByTestId('bring-csv-status')).toContainText(
      'Imported 2 note(s) into "korean-words"',
    );
  });
});
