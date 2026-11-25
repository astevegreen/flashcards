import { expect, test } from '@playwright/test';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
} from '../../packages/core/src/events/replay.ts';
import { createHlcState } from '../../packages/core/src/hlc.ts';
import { deriveNoteId } from '../../packages/core/src/ids.ts';
import { exportFlashpkg } from '../../packages/core/src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../../packages/core/src/model/presets.ts';

function buildTestFlashpkg(
  version: string,
  notes: Array<{ id: string; word: string; meaning: string }>,
): Buffer {
  const st = createEmptyState();
  const factory = createEventFactory('pkg-author', 0, createHlcState('pkg-author', 1000));
  const deckId = 'family-ko-deck';
  applyEvents(st, [
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: 'Family Korean Pack',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: 1000,
      },
      1000,
    ),
    ...notes.map((n, idx) =>
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(deckId, n.id),
          deck_id: deckId,
          source_key: n.id,
          fields: { word: n.word, meaning: n.meaning },
          tags: ['family'],
          provenance: { source: 'import', reviewed: true },
          created_order: idx,
        },
        1000 + idx,
      ),
    ),
  ]);
  return Buffer.from(
    exportFlashpkg(st, {
      packageId: 'pkg:family-ko-pack',
      name: 'Family Korean Pack',
      version,
    }),
  );
}

test.describe('Phase 3 Sources — Google Sheets/Docs & Family Library Package Subscriptions E2E', () => {
  test('mocked Google Sheet template creation, race-guarded Card ID batchUpdate, soft-archive/restore preserving reviews, Sheet edit link, and Google Docs HTML sanitization', async ({
    page,
  }) => {
    // Server-side mutable mock state for Google Sheet & Google Doc
    let sheetModifiedTime = '2026-11-20T10:00:00Z';
    let sheetValues: string[][] = [
      ['Word', 'Hanja / Reading', 'Meaning', 'Example', 'Notes', 'Tags', 'Card ID'],
      ['고양이', '', 'cat', '', '', 'animals', ''],
      ['강아지', '', 'puppy', '', '', 'animals', ''],
    ];
    const batchUpdatePayloads: unknown[] = [];

    await page.route('https://sheets.googleapis.com/v4/spreadsheets**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      if (method === 'POST' && url === 'https://sheets.googleapis.com/v4/spreadsheets') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            spreadsheetId: 'mock-sheet-101',
            spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/mock-sheet-101/edit',
            properties: { title: 'Korean Animals Sheet' },
            sheets: [{ properties: { title: 'Cards' } }],
          }),
        });
        return;
      }

      if (method === 'POST' && url.includes(':batchUpdate')) {
        const body = req.postDataJSON() as {
          data?: Array<{ range?: string; values?: string[][] }>;
        };
        batchUpdatePayloads.push(body);
        // Apply Card ID cell writes to our in-memory mock sheet!
        for (const item of body.data ?? []) {
          const match = /!([A-Z]+)(\d+)$/.exec(item.range ?? '');
          if (match && match[1]) {
            const colLetter = match[1];
            const rowNum = Number(match[2]);
            const colIdx = colLetter.charCodeAt(0) - 65;
            const val = item.values?.[0]?.[0] ?? '';
            const targetRow = sheetValues[rowNum - 1];
            if (targetRow) {
              while (targetRow.length <= colIdx) targetRow.push('');
              targetRow[colIdx] = val;
            }
          }
        }
        sheetModifiedTime = `2026-11-20T10:00:${String(batchUpdatePayloads.length).padStart(2, '0')}Z`;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ totalUpdatedCells: body.data?.length ?? 0 }),
        });
        return;
      }

      if (url.includes('/values/') && url.includes('valueRenderOption=FORMULA')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ values: sheetValues }),
        });
        return;
      }

      if (url.includes('fields=spreadsheetId')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            spreadsheetId: 'mock-sheet-101',
            properties: { title: 'Korean Animals Sheet' },
            sheets: [{ properties: { title: 'Cards' } }],
          }),
        });
        return;
      }

      await route.fulfill({ status: 404, body: 'Not found' });
    });

    await page.route('https://www.googleapis.com/drive/v3/files/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/mock-sheet-101?')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'mock-sheet-101',
            name: 'Korean Animals Sheet',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            modifiedTime: sheetModifiedTime,
            capabilities: { canEdit: true },
          }),
        });
        return;
      }
      if (url.includes('/mock-doc-202/export')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/markdown',
          body: '# Korean Particles Guide\n\nSafe lesson text <script>window.__xss=1</script><b>here</b>.',
        });
        return;
      }
      if (url.includes('/mock-doc-202?')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'mock-doc-202',
            name: 'Korean Particles Guide',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: '2026-11-20T11:00:00Z',
            capabilities: { canEdit: true },
          }),
        });
        return;
      }
      await route.fulfill({ status: 404, body: 'Not found' });
    });

    await page.goto('/?device=sheets1');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Seed valid Google OAuth token + a linked Google Doc in IndexedDB so we exercise real OAuth + Sheets + Docs
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('flashcards-db-sheets1');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        store.put({
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
        store.put({
          key: 'linked_sources_v1',
          value: {
            googleSources: [
              {
                id: 'gdoc:mock-doc-202',
                kind: 'google_docs',
                fileId: 'mock-doc-202',
                name: 'Korean Particles Guide',
                uri: 'https://docs.google.com/document/d/mock-doc-202/edit',
                lastStatus: 'idle',
              },
            ],
            localFolders: [],
            packageSubscriptions: [],
            catalogs: [],
          },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });

    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Go to Library -> create & link mocked Google Sheet from template
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await expect(page.getByTestId('sources-panel')).toBeVisible();

    // Verify Google Doc imported on open/refresh with raw HTML stripped
    await page.getByTestId('refresh-sources-btn').click();
    await expect(page.getByTestId('imported-pages-summary')).toContainText(
      'Korean Particles Guide',
    );

    await page.getByTestId('toggle-sheet-template-btn').click();
    await page.getByPlaceholder('New Google Sheet title').fill('Korean Animals Sheet');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect(page.getByTestId('source-row-mock-sheet-101')).toBeVisible();
    // Card IDs should have been written back via single values:batchUpdate!
    const catCardId = sheetValues[1]?.[6] ?? '';
    const puppyCardId = sheetValues[2]?.[6] ?? '';
    expect(catCardId.length).toBeGreaterThan(8);
    expect(puppyCardId.length).toBeGreaterThan(8);
    expect(catCardId).not.toBe(puppyCardId);

    // Study the Sheet-backed deck: verify Edit dialog offers "Open in Google Sheets ↗"
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Animals Sheet' });
    await expect(page.getByTestId('count-new')).toHaveText('2');

    await page.keyboard.press('e');
    const editDialog = page.locator('dialog[open]');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByTestId('open-source-sheet-link')).toHaveAttribute(
      'href',
      'https://docs.google.com/spreadsheets/d/mock-sheet-101/edit',
    );
    await editDialog.getByRole('button', { name: 'Cancel' }).click();

    // Rate first card (고양이) Easy -> 1 new left
    await page.keyboard.press('Space');
    await page.getByTestId('rate-easy').click();
    await expect(page.getByTestId('count-new')).toHaveText('1');

    // Mutate mocked Sheet: delete 고양이 row, edit 강아지 meaning
    const headerRow = [...(sheetValues[0] ?? [])];
    const savedCatRow = [...(sheetValues[1] ?? [])];
    sheetValues = [headerRow, ['강아지', '', 'puppy / doggie', '', '', 'animals', puppyCardId]];
    sheetModifiedTime = '2026-11-20T12:00:00Z';

    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByTestId('refresh-sources-btn').click();
    await expect(page.getByTestId('library-status')).toContainText('Refreshed sources');

    // Verify Browse shows edited 강아지 and NOT archived 고양이
    await page.getByRole('button', { name: 'Words' }).first().click();
    await page.getByLabel('Search notes by text or tag').fill('doggie');
    await expect(page.getByTestId('browse-list')).toContainText('강아지');

    // Restore 고양이 row on Sheet and refresh -> review history MUST be preserved (still 1 new, NOT 2!)
    sheetValues = [
      headerRow,
      savedCatRow,
      ['강아지', '', 'puppy / doggie', '', '', 'animals', puppyCardId],
    ];
    sheetModifiedTime = '2026-11-20T12:05:00Z';

    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByTestId('refresh-sources-btn').click();

    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Animals Sheet' });
    // 고양이 was already rated Easy earlier, so restoring it must NOT reset it to New!
    await expect(page.getByTestId('count-new')).toHaveText('1');

    // Confirm raw <script> was stripped from stored PageUpserted event
    const hasScriptInEvents = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('flashcards-db-sheets1');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const events = await new Promise<Array<{ type: string; payload: { markdown?: string } }>>(
        (resolve, reject) => {
          const tx = db.transaction('events', 'readonly');
          const req = tx.objectStore('events').getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        },
      );
      db.close();
      const pageEv = events.find((e) => e.type === 'PageUpserted');
      return !pageEv || (pageEv.payload.markdown ?? '').includes('<script');
    });
    expect(hasScriptInEvents).toBe(false);
  });

  test('Family Library index.json catalog + .flashpkg URL subscription, v2 upgrade preserving reviews, and offline study', async ({
    page,
    context,
  }) => {
    let pkgVersion = '1.0.0';
    let pkgEtag = '"v1"';
    let pkgBuffer = buildTestFlashpkg('1.0.0', [
      { id: 'fam-1', word: '하늘', meaning: 'sky' },
      { id: 'fam-2', word: '바다', meaning: 'sea' },
    ]);

    await page.route('https://family.example.test/index.json', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { ETag: `"cat-${pkgVersion}"` },
        body: JSON.stringify({
          format_version: 1,
          name: 'Green Family Library',
          description: 'Curated Korean study packs',
          packages: [
            {
              package_id: 'pkg:family-ko-pack',
              title: 'Family Korean Pack',
              description: 'Nature words',
              url: 'https://family.example.test/ko-pack.flashpkg',
              version: pkgVersion,
              languages: ['ko', 'en'],
            },
          ],
        }),
      });
    });

    await page.route('https://family.example.test/ko-pack.flashpkg', async (route) => {
      const ifNoneMatch = route.request().headers()['if-none-match'];
      if (ifNoneMatch === pkgEtag) {
        await route.fulfill({ status: 304 });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/zip',
        headers: { ETag: pkgEtag },
        body: pkgBuffer,
      });
    });

    await page.goto('/?device=sub1');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Open Library -> subscribe to Family Library catalog
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByTestId('toggle-subscribe-url-btn').click();
    await page.getByTestId('subscribe-url-input').fill('https://family.example.test/index.json');
    await page.getByTestId('subscribe-url-submit').click();

    await expect(page.getByTestId('family-catalog-card')).toContainText('Green Family Library');
    await page
      .getByTestId('catalog-pkg-pkg:family-ko-pack')
      .getByRole('button', { name: 'Subscribe' })
      .click();

    await expect(page.getByTestId('pkg-sub-row-pkg:family-ko-pack')).toContainText('v1.0.0');

    // Study the subscribed deck and rate card 1 (하늘) Easy
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Family Korean Pack' });
    await expect(page.getByTestId('count-new')).toHaveText('2');
    await page.keyboard.press('Space');
    await page.getByTestId('rate-easy').click();
    await expect(page.getByTestId('count-new')).toHaveText('1');

    // Publish v2.0.0: update 하늘 meaning, remove 바다, add 별 (star)
    pkgVersion = '2.0.0';
    pkgEtag = '"v2"';
    pkgBuffer = buildTestFlashpkg('2.0.0', [
      { id: 'fam-1', word: '하늘', meaning: 'sky / heavens' },
      { id: 'fam-3', word: '별', meaning: 'star' },
    ]);

    await page.getByRole('button', { name: 'Decks' }).first().click();
    await page.getByTestId('refresh-sources-btn').click();
    await expect(page.getByTestId('pkg-sub-row-pkg:family-ko-pack')).toContainText('v2.0.0');

    // Confirm updated meaning in Browse
    await page.getByRole('button', { name: 'Words' }).first().click();
    await page.getByLabel('Search notes by text or tag').fill('heavens');
    await expect(page.getByTestId('browse-list')).toContainText('하늘');

    // Go offline and verify subscribed deck continues studying cleanly with 하늘's review preserved (only 별 is new!)
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Family Korean Pack' });
    await expect(page.getByTestId('count-new')).toHaveText('1');
    await expect(page.getByTestId('study-card')).toContainText('별');
    await page.keyboard.press('Space');
    await page.getByTestId('rate-good').click();
    await expect(page.getByTestId('count-new')).toHaveText('0');

    await context.setOffline(false);
  });
});
