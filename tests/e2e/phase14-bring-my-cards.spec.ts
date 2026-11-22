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
  await page.getByRole('button', { name: 'Library' }).first().click();
  await expect(page.locator('h1', { hasText: 'Library' })).toBeVisible();
  await page.getByTestId('bring-my-cards-btn').click();
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

test.describe('Phase 14 Bring my cards: format detection routes to the existing importers', () => {
  test('Anki .apkg (legacy and anki21b) goes to the Anki importer, history off', async ({
    page,
  }) => {
    await openBringMyCards(page, 'p14bringanki');

    await pick(page, fixture('anki/basic-reversed.apkg'));
    await expect(route(page)).toHaveAttribute('data-kind', 'anki');
    const status = page.getByTestId('anki-import-status');
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(status).toContainText('Imported 2 notes into 1 deck (1 new)');
    await expect(page.getByTestId('anki-include-history')).not.toBeChecked();
    await expect(page.getByTestId('anki-field-languages')).toBeVisible();
    await expect(
      page.locator('[data-testid^="deck-row-"]', { hasText: 'Japanese::Vocab' }),
    ).toBeVisible();

    await startOver(page);
    await pick(page, fixture('anki/anki21b.apkg'));
    await expect(route(page)).toHaveAttribute('data-kind', 'anki');
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
    await expect(page.getByTestId('bring-csv-mapping')).toContainText('Text 1 → Word');
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

    await page.getByRole('button', { name: 'Browse' }).first().click();
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
    await page.route('https://sheets.googleapis.com/v4/spreadsheets/**', async (r) => {
      const url = r.request().url();
      if (url.includes('/values/')) {
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
    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByTestId('bring-my-cards-btn').click();

    await page
      .getByTestId('bring-link-input')
      .fill(`https://docs.google.com/spreadsheets/u/0/d/${SHEET_ID}/edit#gid=0`);
    await page.getByTestId('bring-link-submit').click();
    await expect(route(page)).toHaveAttribute('data-kind', 'google-sheets');
    await expect(page.getByTestId('bring-sheets')).toContainText(
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
    );

    const link = page.getByTestId('bring-sheets-link-btn');
    await expect(link).toBeEnabled();
    await link.click();
    const status = page.getByTestId('bring-sheets-status');
    await expect(status).toHaveAttribute('data-phase', 'done');
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

      await page.getByRole('button', { name: 'Library' }).first().click();
      await page.getByTestId('bring-my-cards-btn').click();
      const region = page.locator('#bring-my-cards-region');
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
      expect(await size()).toEqual(fallback);
      await startOver(page);

      await pick(page, fixture('anki/media.apkg'));
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
