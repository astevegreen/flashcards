import { expect, test, type Page, type Route } from '@playwright/test';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
} from '../../packages/core/src/events/replay.ts';
import { createHlcState } from '../../packages/core/src/hlc.ts';
import { deriveNoteId } from '../../packages/core/src/ids.ts';
import { exportFlashpkg } from '../../packages/core/src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../../packages/core/src/model/presets.ts';
import { deckRow, openLibrary } from './helpers/library.ts';

/**
 * Linked Google Drive FILES (§3.1): a `.csv` picked with Google Picker (`drive.file`) refreshes
 * into a deck through `files.get` metadata (md5Checksum) and `alt=media`. The Picker itself is a
 * Google-hosted script, so the linked row is seeded and the Drive API is mocked.
 */

const FILE_ID = 'mock-csv-303';
const PKG_FILE_ID = 'mock-pkg-404';

interface MockFile {
  body: string;
  md5: string;
}

/** One version of the "Drive Family Pack" package, a note per word. */
function buildDrivePackage(version: string, words: readonly string[]): Buffer {
  const st = createEmptyState();
  const factory = createEventFactory('pkg-author', 0, createHlcState('pkg-author', 1000));
  const deckId = 'drive-family-deck';
  applyEvents(st, [
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: 'Drive Family Pack',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: 1000,
      },
      1000,
    ),
    ...words.map((word, idx) =>
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(deckId, word),
          deck_id: deckId,
          source_key: word,
          fields: { word, meaning: `meaning ${idx}` },
          tags: [],
          provenance: { source: 'import', reviewed: true },
          created_order: idx,
        },
        1000 + idx,
      ),
    ),
  ]);
  return Buffer.from(
    exportFlashpkg(st, { packageId: 'pkg:drive-family', name: 'Drive Family Pack', version }),
  );
}

const CSV_ROW = {
  id: `gdrive:${FILE_ID}`,
  fileId: FILE_ID,
  name: 'Drive Vocab',
  format: 'table',
  noteTypeId: 'preset:vocab-ko',
  language: 'ko',
  columnMap: [
    { header: 'word', target: 'field:word' },
    { header: 'meaning', target: 'field:meaning' },
  ],
  lastStatus: 'idle',
};

async function seedDriveFileSource(
  page: Page,
  device: string,
  row: Record<string, unknown> = CSV_ROW,
): Promise<void> {
  await page.evaluate(
    async ({ dbName, row }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
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
            googleSources: [],
            googleDriveFiles: [row],
            localFolders: [],
            packageSubscriptions: [],
            catalogs: [],
          },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: `flashcards-db-${device}`, row },
  );
}

test.describe('Linked Google Drive files', () => {
  test('refreshes a linked Drive .csv by md5Checksum, then unlinks it', async ({ page }) => {
    const file: MockFile = {
      body: 'word,meaning\n바다,sea\n하늘,sky\n',
      md5: 'md5-a',
    };
    const mediaDownloads: string[] = [];

    await page.route('https://www.googleapis.com/drive/v3/files/**', async (route: Route) => {
      const url = new URL(route.request().url());
      const headers = { 'access-control-allow-origin': '*' };
      if (!url.pathname.endsWith(`/${FILE_ID}`)) {
        await route.fulfill({ status: 404, headers, body: 'Not found' });
        return;
      }
      if (url.searchParams.get('alt') === 'media') {
        mediaDownloads.push(file.md5);
        await route.fulfill({ status: 200, headers, contentType: 'text/csv', body: file.body });
        return;
      }
      await route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({
          id: FILE_ID,
          name: 'Drive Vocab.csv',
          mimeType: 'text/csv',
          size: String(new TextEncoder().encode(file.body).byteLength),
          md5Checksum: file.md5,
          webViewLink: `https://drive.google.com/file/d/${FILE_ID}/view`,
        }),
      });
    });

    await page.goto('/?device=gdrivefile1');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await seedDriveFileSource(page, 'gdrivefile1');
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);

    const panel = page.getByTestId('sources-panel');
    await expect(panel).toBeVisible();
    // The Google button covers Drive files now, and the copy names Drive files.
    await expect(page.getByTestId('link-google-source-btn')).toHaveText('Link from Google Drive');
    await expect(page.getByTestId('sources-description')).toContainText('CSV/TSV/XLSX files');

    const row = page.getByTestId(`gdrive-source-row-${FILE_ID}`);
    await expect(row).toContainText('Google Drive file');
    // The post-first-paint source check pulls linked Drive files on launch (C13).
    await expect(row).toContainText('Synced');
    await expect(deckRow(page, 'Drive Vocab')).toBeVisible();
    expect(mediaDownloads).toEqual(['md5-a']);

    // Refresh Sources again: the md5Checksum is unchanged, so nothing is downloaded.
    await page.getByTestId('refresh-sources-btn').click();
    await expect(page.getByTestId('library-status')).toContainText(
      'All linked sources are up to date.',
    );
    expect(mediaDownloads).toEqual(['md5-a']);

    // The file changed in Drive: one row edited, one added.
    file.body = 'word,meaning\n바다,ocean\n하늘,sky\n별,star\n';
    file.md5 = 'md5-b';
    await page.getByTestId(`gdrive-refresh-${FILE_ID}`).click();
    await expect(page.getByTestId('library-status')).toContainText(
      'Refreshed "Drive Vocab" (2 note change(s))',
    );
    expect(mediaDownloads).toEqual(['md5-a', 'md5-b']);

    // Unlink keeps the deck and its notes.
    await page.getByTestId(`gdrive-unlink-${FILE_ID}`).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId('library-status')).toContainText('Source unlinked');
    await expect(deckRow(page, 'Drive Vocab')).toBeVisible();
  });

  test('a linked Drive .flashpkg update that drops notes asks first, naming the package (C9)', async ({
    page,
  }) => {
    const pkg = { bytes: buildDrivePackage('1.0.0', ['바다', '하늘', '별']), md5: 'md5-v1' };
    await page.route('https://www.googleapis.com/drive/v3/files/**', async (route: Route) => {
      const url = new URL(route.request().url());
      const headers = { 'access-control-allow-origin': '*' };
      if (!url.pathname.endsWith(`/${PKG_FILE_ID}`)) {
        await route.fulfill({ status: 404, headers, body: 'Not found' });
        return;
      }
      if (url.searchParams.get('alt') === 'media') {
        await route.fulfill({
          status: 200,
          headers,
          contentType: 'application/octet-stream',
          body: pkg.bytes,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({
          id: PKG_FILE_ID,
          name: 'family-pack.flashpkg',
          mimeType: 'application/octet-stream',
          size: String(pkg.bytes.byteLength),
          md5Checksum: pkg.md5,
          webViewLink: `https://drive.google.com/file/d/${PKG_FILE_ID}/view`,
        }),
      });
    });

    await page.goto('/?device=gdrivepkg1');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await seedDriveFileSource(page, 'gdrivepkg1', {
      id: `gdrive:${PKG_FILE_ID}`,
      fileId: PKG_FILE_ID,
      name: 'family-pack.flashpkg',
      format: 'flashpkg',
      lastStatus: 'idle',
    });
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);

    // The launch check imports v1: a first import archives nothing, so it never asks.
    const row = page.getByTestId(`gdrive-source-row-${PKG_FILE_ID}`);
    await expect(row).toContainText('Synced');
    await expect(deckRow(page, 'Drive Family Pack')).toContainText('3 notes');
    const dialog = page.getByTestId('archive-preview-dialog');
    await expect(dialog).toHaveCount(0);

    // v2 drops 바다 and 별.
    pkg.bytes = buildDrivePackage('2.0.0', ['하늘']);
    pkg.md5 = 'md5-v2';
    await page.getByTestId(`gdrive-refresh-${PKG_FILE_ID}`).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Archive 2 notes?');
    // The package's title, not the file name, with the file underneath.
    await expect(dialog).toContainText('“Drive Family Pack”');
    await expect(dialog.getByTestId('archive-preview-file')).toHaveText(
      'From family-pack.flashpkg',
    );

    // Cancel writes nothing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText('you cancelled the update of "Drive Family Pack"');
    await expect(deckRow(page, 'Drive Family Pack')).toContainText('3 notes');

    // Cancel isn't remembered: the next refresh asks again, and Continue archives the two.
    await page.getByTestId(`gdrive-refresh-${PKG_FILE_ID}`).click();
    await expect(dialog).toContainText('Archive 2 notes?');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText('Synced');
    await expect(row).not.toContainText('cancelled');
    await expect(deckRow(page, 'Drive Family Pack')).toContainText('1 notes');
  });

  test('dev builds show providers missing their env vars as disabled buttons', async ({ page }) => {
    // `?device=` turns on dev mode; this preview build has no Microsoft client ID or Picker key.
    await page.goto('/?device=gdrivehints1');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openLibrary(page);
    const hint = page.getByTestId('unconfigured-source-onedrive');
    await expect(hint).toBeDisabled();
    await expect(page.getByTestId('unconfigured-source-hints')).toContainText('VITE_MS_CLIENT_ID');
    await expect(page.getByTestId('sources-description')).not.toContainText('OneDrive');
  });
});
