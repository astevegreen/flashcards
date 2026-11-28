import { expect, test, type Page } from '@playwright/test';

/**
 * Another tab rebuilding the collection (Check database) makes this tab ask before reloading.
 * "Reload now" waits for this tab's queued writes (`whenSaved()`), so an edit saved just before
 * is still there after the reload.
 */

const CHANNEL = 'flashcards-collection-rebuilt';

/** What another tab of the same device does when it finishes a rebuild. */
async function announce(page: Page, deviceId: string): Promise<void> {
  await page.evaluate(
    ({ channelName, deviceId }) => {
      const channel = new BroadcastChannel(channelName);
      channel.postMessage({ type: 'rebuilt', deviceId });
      channel.close();
    },
    { channelName: CHANNEL, deviceId },
  );
}

test.describe('Reload prompt after a rebuild in another tab', () => {
  test('shows for this device only, and an edit saved just before survives the reload', async ({
    page,
    context,
  }) => {
    await page.goto('/?device=rebuildprompt');
    await expect(page.getByTestId('study-card')).toBeVisible();
    const prompt = page.getByTestId('rebuild-reload-prompt');
    await expect(prompt).toHaveCount(0);

    // The listener mounts lazily. Another device's rebuild is announced repeatedly across that
    // window and must show nothing; then this device's own is announced until the prompt appears
    // (which also shows the listener was live for the earlier messages).
    // The announcing tab only needs this origin's BroadcastChannel, not the app. A second app page
    // on this device queued for the writer lock: on a loaded machine it could still hold that
    // request when this page reloaded, so the reload came back to "open in another tab". A plain
    // same-origin text file (`.txt` skips the service worker's app fallback) boots nothing.
    const other = await context.newPage();
    await other.goto('/THIRD-PARTY-NOTICES.txt');
    for (let i = 0; i < 8; i++) {
      await announce(other, 'device-someone-else');
      await page.waitForTimeout(200); // NOSONAR (S2925): a negative needs a timed window; no event marks "ignored"
    }
    await expect(prompt).toHaveCount(0);
    await expect(async () => {
      await announce(other, 'device-rebuildprompt');
      await expect(prompt).toBeVisible({ timeout: 500 });
    }).toPass();
    await expect(prompt).toContainText('rebuilt in another tab');
    await other.close();

    // Edit and save, then reload straight away: whenSaved() lets the write reach storage first.
    await page.keyboard.press('e');
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Meaning').fill('saved before reload');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    const reload = prompt.getByRole('button', { name: 'Reload now' });
    await Promise.all([page.waitForEvent('load'), reload.click()]);
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect(prompt).toHaveCount(0);

    await page.keyboard.press('e');
    await expect(page.locator('dialog[open]').getByLabel('Meaning')).toHaveValue(
      'saved before reload',
    );
  });
});
