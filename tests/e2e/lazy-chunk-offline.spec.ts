import { expect, test } from '@playwright/test';

// The service worker would answer chunk requests itself; block it so `page.route` sees them.
test.use({ serviceWorkers: 'block' });

test.describe('Lazy chunks that cannot load', () => {
  test('a blocked screen shows an inline message, the app keeps working, and Retry recovers', async ({
    page,
  }) => {
    let blocked = true;
    let attempts = 0;
    await page.route(/\/assets\/StatsScreen-[^/]+\.js$/, async (route) => {
      if (blocked) {
        attempts++;
        await route.abort('internetdisconnected');
        return;
      }
      await route.continue();
    });

    await page.goto('/?device=lazychunk');
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Stats' }).first().click();
    const alert = page.getByRole('alert').filter({ hasText: "isn't available offline yet" });
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(
      /This part of the app isn't available offline yet\. Reconnect and try again\./,
    );
    // The first try plus the helper's automatic retries all hit the blocked chunk.
    expect(attempts).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('stats-screen')).toHaveCount(0);

    // Navigation and the study screen still work while Stats can't load.
    await page.getByRole('button', { name: 'Study' }).first().click();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();

    // Still blocked: Retry fails again and the message stays.
    await page.getByRole('button', { name: 'Stats' }).first().click();
    await expect(alert).toBeVisible();
    const before = attempts;
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => attempts).toBeGreaterThan(before);
    await expect(alert).toBeVisible();

    // Reconnected: Retry loads the screen.
    blocked = false;
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('stats-screen')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Statistics' })).toBeVisible();
    await expect(alert).toHaveCount(0);
  });

  test('coming back online retries a failed chunk by itself', async ({ page, context }) => {
    let blocked = true;
    await page.route(/\/assets\/StatsScreen-[^/]+\.js$/, async (route) => {
      if (blocked) await route.abort('internetdisconnected');
      else await route.continue();
    });

    await page.goto('/?device=lazychunk-online');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Stats' }).first().click();
    await expect(page.getByRole('alert').filter({ hasText: 'offline' })).toBeVisible();

    blocked = false;
    await context.setOffline(true);
    await context.setOffline(false); // fires `online`
    await expect(page.getByTestId('stats-screen')).toBeVisible();
  });

  test('a blocked dialog on the study screen leaves the card usable', async ({ page }) => {
    let blocked = true;
    await page.route(/\/assets\/NoteEditDialog-[^/]+\.js$/, async (route) => {
      if (blocked) await route.abort('internetdisconnected');
      else await route.continue();
    });

    await page.goto('/?device=lazychunk-dialog');
    const card = page.getByTestId('study-card');
    await expect(card).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: "isn't available offline yet" });
    await expect(alert).toBeVisible();

    // Close drops the failed dialog; the card can still be flipped and rated.
    await alert.getByRole('button', { name: 'Close' }).click();
    await expect(alert).toHaveCount(0);
    const startNew = Number(await page.getByTestId('count-new').textContent());
    await page.getByRole('button', { name: 'Show Answer (Space)' }).click();
    await expect(page.getByTestId('card-back')).toBeVisible();
    await page.keyboard.press('2');
    await expect(page.getByTestId('count-new')).toHaveText(String(startNew - 1));

    // Reconnected: opening it again and pressing Retry loads the dialog.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(alert).toBeVisible();
    blocked = false;
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('button', { name: 'Close dialog' })).toBeVisible();
    await expect(alert).toHaveCount(0);
  });
});
