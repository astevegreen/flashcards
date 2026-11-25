import { expect, test, type Page, type Route } from '@playwright/test';
import { deckRow, openLibrary } from './helpers/library.ts';

/**
 * Linked Google Drive FILES (§3.1): a `.csv` picked with Google Picker (`drive.file`) refreshes
 * into a deck through `files.get` metadata (md5Checksum) and `alt=media`. The Picker itself is a
 * Google-hosted script, so the linked row is seeded and the Drive API is mocked.
 */

const FILE_ID = 'mock-csv-303';

interface MockFile {
  body: string;
  md5: string;
}

async function seedDriveFileSource(page: Page, device: string): Promise<void> {
  await page.evaluate(
    async ({ dbName, fileId }) => {
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
            googleDriveFiles: [
              {
                id: `gdrive:${fileId}`,
                fileId,
                name: 'Drive Vocab',
                format: 'table',
                noteTypeId: 'preset:vocab-ko',
                language: 'ko',
                columnMap: [
                  { header: 'word', target: 'field:word' },
                  { header: 'meaning', target: 'field:meaning' },
                ],
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
    },
    { dbName: `flashcards-db-${device}`, fileId: FILE_ID },
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
    await page.getByTestId('refresh-sources-btn').click();
    await expect(page.getByTestId('library-status')).toContainText('Refreshed sources');
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
