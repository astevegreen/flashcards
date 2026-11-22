import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 13 remainder: study reminders (PWA badge), "Reveal more" arrow keys, pull-to-refresh in
 * scroll containers, the sync badge in short landscape, Settings layout stability and the Browse
 * list + detail split view.
 */

async function studyCounts(page: Page): Promise<string[]> {
  return Promise.all(
    ['count-new', 'count-learning', 'count-due'].map(
      async (id) => (await page.getByTestId(id).textContent()) ?? '',
    ),
  );
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click();
}

test.describe('Phase 13 study reminders (PWA)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('off by default; when on, the Study tab badge shows the due count after the reminder time', async ({
    page,
  }) => {
    // The PWA never asks for notification permission: count any request.
    await page.addInitScript(() => {
      const w = window as unknown as { __notificationRequests: number };
      w.__notificationRequests = 0;
      if ('Notification' in window) {
        Notification.requestPermission = () => {
          w.__notificationRequests += 1;
          return Promise.resolve('denied');
        };
      }
    });
    await page.goto('/?device=reminders');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openTab(page, 'Settings');

    const toggle = page.getByLabel(/Daily study reminder/);
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('study-reminder-badge')).toHaveCount(0);

    // Midnight: today's reminder time has always passed, so the badge shows right away.
    await page.getByTestId('study-reminder-time').fill('00:00');
    await toggle.check();
    await expect(toggle).toBeChecked();
    const badge = page
      .getByRole('navigation', { name: 'Mobile navigation' })
      .getByTestId('study-reminder-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/^\d+\+? cards due$/);
    expect(Number.parseInt((await badge.textContent()) ?? '', 10)).toBeGreaterThan(0);

    // Device-local setting: survives a reload.
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await expect(badge).toBeVisible();
    await openTab(page, 'Settings');
    await expect(toggle).toBeChecked();
    await expect(page.getByTestId('study-reminder-time')).toHaveValue('00:00');

    await toggle.uncheck();
    await expect(page.getByTestId('study-reminder-badge')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { __notificationRequests: number }).__notificationRequests,
      ),
    ).toBe(0);
  });
});

test.describe('Phase 13 layout fixes', () => {
  test('arrow keys on "Reveal more" move focus and never rate', async ({ page }) => {
    await page.goto('/?device=revealarrows');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Find a card with more than one reveal step.
    const more = page.getByTestId('reveal-more-button');
    for (let i = 0; i < 10; i++) {
      await page.getByTestId('reveal-button').click();
      await expect(page.getByTestId('card-back')).toBeVisible();
      if (await more.isVisible()) break;
      await page.getByTestId('rate-good').click();
    }
    await expect(more).toBeVisible();
    const label = await more.textContent();
    const counts = await studyCounts(page);

    await more.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(more).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(more).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('rate-again')).toBeFocused();
    await more.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('rate-again')).toBeFocused();

    // Still the same card at the same step: nothing was rated or revealed.
    await expect(more).toHaveText(label ?? '');
    expect(await studyCounts(page)).toEqual(counts);
  });

  test.describe('short landscape', () => {
    test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });

    test('the slim rail keeps the sync badge', async ({ page }) => {
      await page.goto('/?device=shortbadge');
      await expect(page.getByTestId('study-card')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeHidden();
      const syncBadge = page.getByTestId('sidebar-sync-badge');
      await expect(syncBadge).toBeVisible();
      const box = await syncBadge.boundingBox();
      expect(box).toBeTruthy();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(64 + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(390);
      }
    });
  });

  test.describe('phones', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('Settings does not reflow when the sync status text changes', async ({ page }) => {
      await page.goto('/?device=settingsstable');
      await expect(page.getByTestId('study-card')).toBeVisible();
      await openTab(page, 'Settings');
      const install = page.getByTestId('pack-install-btn-dict-krdict');
      await expect(install).toBeVisible({ timeout: 10_000 });

      // What the first sync does to the status texts, set directly so timing cannot matter.
      const setStatus = (lastSynced: string, pill: string) =>
        page.evaluate(
          ([last, status]) => {
            const lastEl = document.querySelector('[data-testid="sync-last-synced"]');
            const pillEl = document.querySelector('[data-testid="sync-status-pill"]');
            if (lastEl) lastEl.textContent = last ?? '';
            if (pillEl) pillEl.textContent = status ?? '';
          },
          [lastSynced, pill],
        );
      await setStatus('Never', 'Idle');
      const before = await install.boundingBox();
      await setStatus(new Date(2026, 10, 22, 23, 59, 59).toLocaleString('en-US'), 'Syncing…');
      const after = await install.boundingBox();
      expect(before && after).toBeTruthy();
      expect(after?.y).toBe(before?.y);
      expect(after?.x).toBe(before?.x);
    });
  });

  test.describe('pull to refresh', () => {
    test.use({ viewport: { width: 390, height: 640 }, isMobile: true, hasTouch: true });

    /** Starts a downward pull on the first Browse row, returns whether the sync hint shows. */
    async function pullOnFirstRow(page: Page): Promise<boolean> {
      await page.getByTestId('browse-list').evaluate((list) => {
        const target = list.querySelector('[data-testid^="browse-row-"] button') ?? list;
        const touch = (y: number) => new Touch({ identifier: 1, target, clientX: 120, clientY: y });
        const fire = (type: string, y: number) =>
          target.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: [touch(y)],
              targetTouches: [touch(y)],
              changedTouches: [touch(y)],
            }),
          );
        fire('touchstart', 200);
        fire('touchmove', 240);
        fire('touchmove', 300);
      });
      const hint = page.getByRole('status').filter({ hasText: /sync…?$/ });
      const shown = await hint
        .first()
        .waitFor({ state: 'visible', timeout: 1_000 })
        .then(() => true)
        .catch(() => false);
      await page.getByTestId('browse-list').evaluate((list) => {
        list.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true }));
      });
      return shown;
    }

    test('a pull inside a scrolled list scrolls instead of syncing', async ({ page }) => {
      await page.goto('/?device=pullrefresh');
      await expect(page.getByTestId('study-card')).toBeVisible();
      await openTab(page, 'Browse');
      const list = page.getByTestId('browse-list');
      await expect(list.locator('[data-testid^="browse-row-"]').first()).toBeVisible();

      // At the top of the list (and the page) a pull is a refresh gesture.
      expect(await pullOnFirstRow(page)).toBe(true);
      await expect(page.getByText('Release to sync…')).toHaveCount(0);

      // Scrolled inside the list (the window stays at the top): a pull is a scroll.
      const scrollable = await list.evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(scrollable).toBe(true);
      await list.evaluate((el) => {
        el.scrollTop = 40;
      });
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      expect(await pullOnFirstRow(page)).toBe(false);
    });
  });
});

test.describe('Phase 13 Browse split view', () => {
  async function openBrowse(page: Page, device: string): Promise<void> {
    await page.goto(`/?device=${device}`);
    await expect(page.getByTestId('study-card')).toBeVisible();
    await openTab(page, 'Browse');
    await expect(
      page.getByTestId('browse-list').locator('[data-testid^="browse-row-"]').first(),
    ).toBeVisible();
  }

  async function rowId(page: Page, index: number): Promise<string> {
    const testId = await page
      .getByTestId('browse-list')
      .locator('[data-testid^="browse-row-"]')
      .nth(index)
      .getAttribute('data-testid');
    return (testId ?? '').slice('browse-row-'.length);
  }

  test('wide screens show the list beside a detail pane', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBrowse(page, 'browsesplit');
    const list = page.getByTestId('browse-list');
    const detail = page.getByTestId('browse-detail');
    await expect(detail).toBeVisible();

    const listBox = await list.boundingBox();
    const detailBox = await detail.boundingBox();
    expect(listBox && detailBox).toBeTruthy();
    if (listBox && detailBox) {
      expect(detailBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width - 1);
      expect(Math.abs(detailBox.y - listBox.y)).toBeLessThanOrEqual(2);
    }

    // The first note is shown until another row's Details button picks one.
    const first = await rowId(page, 0);
    const second = await rowId(page, 1);
    await expect(page.getByTestId(`browse-row-${first}`)).toHaveAttribute('data-selected', 'true');
    const firstHeadline = await page.getByTestId('browse-detail-headline').textContent();
    await page.getByTestId(`browse-show-${second}`).click();
    await expect(page.getByTestId(`browse-row-${second}`)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId(`browse-show-${second}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('browse-detail-headline')).not.toHaveText(firstHeadline ?? '');
    await expect(detail.getByRole('list', { name: 'Cards' })).toBeVisible();

    // Keyboard: the Details button selects without a pointer.
    await page.getByTestId(`browse-show-${first}`).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('browse-detail-headline')).toHaveText(firstHeadline ?? '');

    // Edit opens the same editor as tapping the row.
    await page.getByTestId('browse-detail-edit').click();
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test.describe('phones', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('phones keep the single-column list', async ({ page }) => {
      await openBrowse(page, 'browsephone');
      await expect(page.getByTestId('browse-detail')).toBeHidden();
      const first = await rowId(page, 0);
      await expect(page.getByTestId(`browse-show-${first}`)).toBeHidden();
      // Tapping a row still opens the editor.
      await page
        .getByTestId(`browse-row-${first}`)
        .getByRole('button')
        .filter({ hasNotText: /^(Suspend|Unsuspend|Details|Restore|Mark reviewed)$/ })
        .first()
        .click();
      await expect(page.locator('dialog[open]')).toBeVisible();
    });
  });
});
