import { expect, test, type Page } from '@playwright/test';
import {
  FakeGraphServer,
  installMicrosoftFakes,
  type MicrosoftFakes,
} from './helpers/microsoft-fakes.ts';

/**
 * Phase 12 OneDrive storage connector, end to end against the shared in-process fake Graph
 * (`packages/platform-web/tests/fakes/fake-graph.ts`). Microsoft sign-in, the token-helper and
 * Graph are all answered by `context.route` (`helpers/microsoft-fakes.ts`), so nothing leaves the
 * machine.
 */

async function connectOneDrive(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByTestId('connect-onedrive-btn').click();
  // Full-page round trip through the faked Microsoft sign-in, then the app-open sync.
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByText('OneDrive (App Folder)')).toBeVisible();
  await expect(page.getByTestId('sync-status-pill')).toHaveText('Synced');
}

test.describe('Phase 12 OneDrive storage connector (fake Graph)', () => {
  test('two devices converge through the OneDrive app folder', async ({ browser }) => {
    const fakes: MicrosoftFakes = { graph: new FakeGraphServer(), exchanges: [] };

    // Separate contexts: no shared BroadcastChannel, so OneDrive is the only path between them.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    await installMicrosoftFakes(contextA, fakes, () => `device=oda`);
    await installMicrosoftFakes(contextB, fakes, () => `device=odb`);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto(`/?device=oda`);
    await expect(pageA.getByTestId('study-card')).toBeVisible();
    await pageA.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(pageA.getByTestId('count-new')).toHaveText('4');

    await connectOneDrive(pageA);
    expect(fakes.exchanges[0]?.scope).toBe('Files.ReadWrite.AppFolder offline_access');
    expect(fakes.graph.appFolder.files.size).toBeGreaterThan(0);

    // Review one card on A and push it.
    await pageA.getByRole('button', { name: 'Study' }).first().click();
    await pageA.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await pageA.keyboard.press('Space');
    await pageA.getByTestId('rate-good').click();
    await expect(pageA.getByTestId('count-new')).toHaveText('3');
    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');

    // B connects to the same app folder and pulls A's review.
    await pageB.goto(`/?device=odb`);
    await expect(pageB.getByTestId('study-card')).toBeVisible();
    await connectOneDrive(pageB);
    await pageB.getByRole('button', { name: 'Study' }).first().click();
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(pageB.getByTestId('count-new')).toHaveText('3');

    expect(fakes.graph.authLeaks).toEqual([]);
    await contextA.close();
    await contextB.close();
  });

  test('OneDrive file picker asks for read access once, then imports a CSV as a new deck', async ({
    browser,
  }) => {
    const fakes: MicrosoftFakes = { graph: new FakeGraphServer(), exchanges: [] };
    fakes.graph.drive.put(
      'Decks/OneDrive Animals.csv',
      new TextEncoder().encode('word,meaning\n고양이,cat\n강아지,puppy\n'),
      Date.now(),
    );
    fakes.graph.drive.put('Decks/notes.txt', new TextEncoder().encode('ignored'), Date.now());

    const context = await browser.newContext();
    await installMicrosoftFakes(context, fakes, () => `device=odpick`);
    const page = await context.newPage();
    await page.goto(`/?device=odpick`);
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByTestId('onedrive-import-btn').click();
    await page.getByTestId('onedrive-grant-access-btn').click();

    // Back from consent: the picker sign-in did not turn on OneDrive sync.
    await expect(page.getByTestId('study-card')).toBeVisible();
    expect(fakes.exchanges[0]?.scope).toBe('Files.ReadWrite.AppFolder offline_access Files.Read');
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('connect-onedrive-btn')).toBeVisible();

    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByTestId('onedrive-import-btn').click();
    await page.getByTestId('onedrive-folder-Decks').click();
    await expect(page.getByTestId('onedrive-file-notes.txt')).toHaveCount(0);
    await page.getByTestId('onedrive-file-OneDrive Animals.csv').click();
    await expect(
      page.getByText('Imported 2 note(s) from OneDrive into "OneDrive Animals"'),
    ).toBeVisible();
    expect(fakes.graph.appFolder.files.size).toBe(0);

    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'OneDrive Animals' });
    await expect(page.getByTestId('count-new')).toHaveText('2');
    await context.close();
  });

  test('the OneDrive picker keeps one height from lazy load to a long listing', async ({
    browser,
  }) => {
    const fakes: MicrosoftFakes = { graph: new FakeGraphServer(), exchanges: [] };
    for (let i = 0; i < 30; i++) {
      fakes.graph.drive.put(`Folder ${String(i).padStart(2, '0')}/a.csv`, new Uint8Array(), 0);
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await installMicrosoftFakes(context, fakes, () => `device=odlayout`);
    const page = await context.newPage();
    await page.goto(`/?device=odlayout`);
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByTestId('onedrive-import-btn').click();
    await page.getByTestId('onedrive-grant-access-btn').click();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Library' }).first().click();

    // Every frame from the click on: the fallback or panel height (with the state it is in).
    await page.evaluate(() => {
      const samples: string[] = [];
      (window as unknown as { __pickerSamples: string[] }).__pickerSamples = samples;
      const tick = () => {
        const el =
          document.querySelector('[data-testid="onedrive-picker-panel"]') ??
          document.querySelector('[data-testid="onedrive-picker-fallback"]');
        if (el) samples.push(String(Math.round(el.getBoundingClientRect().height)));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.getByTestId('onedrive-import-btn').click();
    await expect(page.getByTestId('onedrive-folder-Folder 29')).toBeAttached();
    const read = () =>
      page.evaluate(() => (window as unknown as { __pickerSamples: string[] }).__pickerSamples);
    await expect.poll(async () => (await read()).length).toBeGreaterThan(20);
    expect(new Set(await read()).size).toBe(1);
    await context.close();
  });
});
