import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  FakeGraphServer,
  installMicrosoftFakes,
  type MicrosoftFakes,
} from './helpers/microsoft-fakes.ts';

/**
 * Phase 14 "Sync my devices" and "Add another device". A device that syncs shows a QR code and a
 * short link carrying only the provider and the collection id; a new device that opens the link
 * gets "Sync my devices" with that provider preselected, signs in by itself, and is told whether
 * it reached the same collection. OneDrive is faked end to end (`helpers/microsoft-fakes.ts`).
 */

const COLLECTION_RE = /col-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const OTHER_COLLECTION = 'col-00000000-0000-7000-8000-000000000000';

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('cloud-sync-card')).toBeVisible();
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Signs in through "Sync my devices" (the link's provider is preselected) and waits for sync. */
async function syncMyDevicesFromSettings(page: Page): Promise<void> {
  await openSettings(page);
  const flow = page.getByTestId('cloud-sync-card').getByTestId('sync-my-devices');
  await expect(flow.getByTestId('sync-my-devices-link-note')).toContainText('OneDrive');
  await expect(flow).toContainText('Uses OneDrive.');
  await flow.getByTestId('sync-my-devices-primary').click();
  // Full-page round trip through the faked Microsoft sign-in, then the app-open sync.
  await expect(page.getByTestId('study-card')).toBeVisible();
  await openSettings(page);
  await expect(page.getByText('OneDrive (App Folder)')).toBeVisible();
  await expect(page.getByTestId('sync-status-pill')).toHaveText('Synced');
}

/** Device A: dev-seeded cards, connected to the faked OneDrive and synced once. */
async function syncingDeviceA(
  browser: Browser,
  fakes: MicrosoftFakes,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installMicrosoftFakes(context, fakes, () => 'device=ada');
  const page = await context.newPage();
  await page.goto('/?device=ada');
  await expect(page.getByTestId('study-card')).toBeVisible();
  await openSettings(page);
  await page.getByTestId('connect-onedrive-btn').click();
  await expect(page.getByTestId('study-card')).toBeVisible();
  await openSettings(page);
  await expect(page.getByTestId('sync-status-pill')).toHaveText('Synced');
  return { context, page };
}

/** The add-device link device A shows (Settings > Cloud Sync > Add a device). */
async function addDeviceLinkOf(page: Page): Promise<URL> {
  await page.getByTestId('add-device-btn').click();
  const link = (await page.getByTestId('add-device-link').textContent()) ?? '';
  return new URL(link);
}

test.describe('Phase 14 Sync my devices', () => {
  test('a new device opened from the link gets Sync my devices with that provider, and the link leaves the address bar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`/?sync=google&col=col-0190f5c2-1234-7abc-8def-0123456789ab`);
    const panel = page.getByTestId('sync-my-devices');
    await expect(panel).toBeVisible();
    // An existing user's second device: no onboarding, the sync flow instead.
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
    await expect(panel.getByTestId('sync-my-devices-link-note')).toContainText(
      'Your other device syncs with Google Drive',
    );
    await expect(panel.getByTestId('sync-my-devices-primary')).toHaveText(
      'Continue with Google Drive',
    );
    await expect(panel.getByTestId('sync-option-local_folder')).toBeVisible();
    await expect(panel).toContainText('scan its QR code or open its link here');
    expect(new URL(page.url()).search).toBe('');
    await expectNoSidewaysScroll(page);

    // The empty-screen button toggles the same flow; onboarding is still there for a new user.
    await page.getByTestId('empty-sync-my-devices-btn').click();
    await expect(page.getByTestId('onboarding')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('onboarding')).toBeVisible();
    await expect(page.getByTestId('sync-my-devices')).toHaveCount(0);
  });

  test('malformed links are ignored and stripped', async ({ page }) => {
    for (const query of [
      '?sync=evil',
      '?sync=google&col=col-not-a-uuid',
      '?sync=google&sync=dropbox',
      '?col=col-0190f5c2-1234-7abc-8def-0123456789ab',
    ]) {
      await page.goto(`/${query}`);
      await expect(page.getByTestId('onboarding')).toBeVisible();
      await expect(page.getByTestId('sync-my-devices')).toHaveCount(0);
      expect(new URL(page.url()).search, query).toBe('');
    }
  });

  test('Settings: one Sync my devices button with Google Drive by default, the rest below', async ({
    page,
  }) => {
    await page.goto('/');
    await openSettings(page);
    const flow = page.getByTestId('cloud-sync-card').getByTestId('sync-my-devices');
    await expect(flow.getByTestId('sync-my-devices-primary')).toHaveText('Sync my devices');
    await expect(flow).toContainText('Uses Google Drive.');
    await expect(page.getByTestId('connect-local-folder-btn')).toBeVisible();
    // Nothing syncs yet, so there is no add-device code to show.
    await expect(page.getByTestId('add-device-btn')).toHaveCount(0);
  });

  test('add a device: QR code and link on one device, the same collection on the other', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const fakes: MicrosoftFakes = { graph: new FakeGraphServer(), exchanges: [] };
    const { context: contextA, page: pageA } = await syncingDeviceA(browser, fakes);

    // Device A shows the code at phone width without sideways scrolling.
    await pageA.setViewportSize({ width: 320, height: 800 });
    await pageA.getByTestId('add-device-btn').click();
    const panel = pageA.getByTestId('add-device-panel');
    await expect(panel.getByRole('img', { name: /QR code/ })).toBeVisible();
    const link = (await panel.getByTestId('add-device-link').textContent()) ?? '';
    const url = new URL(link);
    expect(url.searchParams.get('sync')).toBe('onedrive');
    expect(url.searchParams.get('col')).toMatch(COLLECTION_RE);
    // Provider and collection only: no device, account, token or code.
    expect(new Set(url.searchParams.keys())).toEqual(new Set(['col', 'sync']));
    expect([...url.searchParams.keys()]).toHaveLength(2);
    expect(link).not.toMatch(/token|graph|refresh|code=|device=/i);
    await panel.getByTestId('add-device-copy-btn').click();
    await expect(panel.getByTestId('add-device-copy-status')).toHaveText('Link copied.');
    expect(await pageA.evaluate(() => navigator.clipboard.readText())).toBe(link);
    const box = await panel.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 320).toBe(true);
    expect(
      await panel.evaluate((el) => el.scrollWidth - el.clientWidth),
      'nothing in the panel is wider than the panel',
    ).toBeLessThanOrEqual(0);

    // Device B opens the link (plus its own dev slug), signs in by itself, and reaches A's collection.
    const contextB = await browser.newContext();
    await installMicrosoftFakes(contextB, fakes, () => 'device=adb');
    const pageB = await contextB.newPage();
    await pageB.goto(`${url.pathname}${url.search}&device=adb`);
    // A device with cards goes straight to Settings, where Sync my devices has OneDrive preselected.
    await expect(pageB.getByTestId('cloud-sync-card')).toBeVisible();
    expect(new URL(pageB.url()).searchParams.has('sync')).toBe(false);
    await syncMyDevicesFromSettings(pageB);
    await expect(pageB.getByTestId('add-device-collection-check')).toHaveAttribute(
      'data-check',
      'match',
    );
    await expect(pageB.getByTestId('add-device-collection-check')).toHaveText(
      'Connected to the same collection as your other device.',
    );

    // Device C opens a link to a collection this account does not hold: it is told so.
    const contextC = await browser.newContext();
    await installMicrosoftFakes(contextC, fakes, () => 'device=adc');
    const pageC = await contextC.newPage();
    await pageC.goto(`/?sync=onedrive&col=${OTHER_COLLECTION}&device=adc`);
    await syncMyDevicesFromSettings(pageC);
    await expect(pageC.getByTestId('add-device-collection-check')).toHaveAttribute(
      'data-check',
      'mismatch',
    );
    // Someone who means to keep this collection dismisses the notice, and it stays gone.
    await pageC.getByTestId('add-device-collection-dismiss').click();
    await expect(pageC.getByTestId('add-device-collection-check')).toHaveCount(0);
    await pageC.reload();
    await openSettings(pageC);
    await expect(pageC.getByText('OneDrive (App Folder)')).toBeVisible();
    await expect(pageC.getByTestId('add-device-collection-check')).toHaveCount(0);

    expect(fakes.graph.authLeaks).toEqual([]);
    await contextA.close();
    await contextB.close();
    await contextC.close();
  });

  test('an empty new device joins through the link and its sign-in redirect, never offered onboarding', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const fakes: MicrosoftFakes = { graph: new FakeGraphServer(), exchanges: [] };
    const { context: contextA, page: pageA } = await syncingDeviceA(browser, fakes);
    const url = await addDeviceLinkOf(pageA);

    // Device B is a fresh install: no dev slug, so no seeded cards, and an empty collection.
    const contextB = await browser.newContext();
    await installMicrosoftFakes(contextB, fakes, () => '');
    // Records whether onboarding is ever in the page, across the sign-in redirect's reload.
    await contextB.addInitScript(() => {
      const mark = () => {
        if (document.querySelector('[data-testid="onboarding"]')) {
          sessionStorage.setItem('e2e-onboarding-seen', '1');
        }
      };
      new MutationObserver(mark).observe(document, { childList: true, subtree: true });
    });
    const pageB = await contextB.newPage();
    await pageB.goto(`${url.pathname}${url.search}`);
    const panel = pageB.getByTestId('sync-my-devices');
    await expect(panel.getByTestId('sync-my-devices-primary')).toHaveText('Continue with OneDrive');
    await panel.getByTestId('sync-my-devices-primary').click();
    // Full-page round trip through the faked Microsoft sign-in; then the first pull brings A's cards.
    await expect(pageB.getByTestId('study-card')).toBeVisible({ timeout: 30_000 });
    expect(await pageB.evaluate(() => sessionStorage.getItem('e2e-onboarding-seen'))).toBeNull();
    await expect(pageB.getByTestId('onboarding')).toHaveCount(0);

    await openSettings(pageB);
    await expect(pageB.getByText('OneDrive (App Folder)')).toBeVisible();
    expect(fakes.graph.authLeaks).toEqual([]);
    await contextA.close();
    await contextB.close();
  });

  test('Reset Local Device Data after opening a link behaves like a fresh install', async ({
    page,
  }) => {
    await page.goto('/?sync=google&col=col-0190f5c2-1234-7abc-8def-0123456789ab');
    await expect(page.getByTestId('sync-my-devices')).toBeVisible();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
    await openSettings(page);
    await expect(
      page.getByTestId('cloud-sync-card').getByTestId('sync-my-devices-link-note'),
    ).toContainText('Google Drive');
    await page.getByRole('button', { name: 'Reset Local Device Data' }).click();
    await expect(page.getByText('Local device storage cleared.')).toBeVisible();
    // No link survives the reset: Settings offers the default provider again.
    await expect(
      page.getByTestId('cloud-sync-card').getByTestId('sync-my-devices-link-note'),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Study', exact: true }).first().click();
    await expect(page.getByTestId('onboarding')).toBeVisible();
    await expect(page.getByTestId('sync-my-devices')).toHaveCount(0);
  });

  test('cards that did not come through onboarding still get the one-time sync prompt', async ({
    page,
  }) => {
    // No onboarding record at all, like a collection from before onboarding existed.
    await page.goto('/');
    await expect(page.getByTestId('onboarding')).toBeVisible();
    await openSettings(page);
    await page.getByRole('button', { name: 'Load Sample Decks' }).click();
    await page.getByRole('button', { name: 'Study', exact: true }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Mandarin Basics (ZH)' });
    const caughtUp = page.getByRole('heading', { name: 'All caught up for today!' });
    for (let i = 0; i < 40 && !(await caughtUp.isVisible()); i++) {
      await expect(page.getByTestId('study-card')).toBeVisible();
      await page.keyboard.press('Space');
      await page.getByTestId('rate-easy').click();
    }
    await expect(caughtUp).toBeVisible();
    await expect(page.getByTestId('onboarding-sync-prompt')).toBeVisible();
  });
});
