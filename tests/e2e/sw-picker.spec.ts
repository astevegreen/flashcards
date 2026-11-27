import { expect, test } from '@playwright/test';

// N3 / §9: Custom Tabs share Chrome's service worker, so once the PWA has run, the worker must
// neither precache the Google Picker bridge nor answer its navigation with the app shell.
test.describe('Service worker and the Picker bridge page', () => {
  test('the built sw.js never precaches picker.html (its navigation behaviour is checked below)', async ({
    request,
  }) => {
    const response = await request.get('/sw.js');
    expect(response.ok()).toBe(true);
    const sw = await response.text();
    expect(sw).toContain('index.html');
    expect(sw).not.toMatch(/url:\s*["']\/?picker\.(?:html|js)["']/);
  });

  test('a page the worker controls still loads the real picker.html', async ({ page }) => {
    await page.goto('/?device=swpicker');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // clientsClaim: the worker takes this page over once it activates.
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);

    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) urls.push(new URL(req.url).pathname);
      }
      return urls;
    });
    expect(cached).toContain('/index.html');
    expect(cached.filter((path) => path.startsWith('/picker'))).toEqual([]);

    // Behaviour, not the worker's source: a navigation to the bridge page goes to the network (the
    // worker does not answer it), rather than being served the app shell's index.html.
    const [bridge] = await Promise.all([
      page.waitForResponse((res) => new URL(res.url()).pathname === '/picker.html'),
      page.goto('/picker.html?mode=sheets'),
    ]);
    expect(bridge.fromServiceWorker()).toBe(false);
    await expect(page).toHaveTitle(/Select Google Sheets or Docs/);
    await expect(page.locator('#status')).toContainText('Missing required Picker authorization');
    await expect(page.getByTestId('study-card')).toHaveCount(0);
  });
});
