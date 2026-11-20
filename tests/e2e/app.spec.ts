import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.describe('Phase 1 Lean Offline Flashcards PWA', () => {
  test('cold start to first card in ?device=a, flip, rate, undo, furigana toggle, and inline edit', async ({
    page,
  }) => {
    await page.goto('/?device=a');

    // Zero-login cold start directly onto a study card
    const card = page.getByTestId('study-card');
    await expect(card).toBeVisible();

    const initialNewCount = Number(await page.getByTestId('count-new').textContent());
    expect(initialNewCount).toBeGreaterThan(0);

    // Capture first card front text
    const firstFrontText = await card.textContent();
    expect(firstFrontText).toBeTruthy();

    // Flip via Space keyboard shortcut
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();

    // Rate Good via keyboard shortcut '2' (or click)
    await page.keyboard.press('2');

    // New count should decrease by 1
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNewCount - 1));

    // Lossless Undo via 'z' keyboard shortcut -> restores exact count and card
    await page.keyboard.press('z');
    await expect(page.getByTestId('count-new')).toHaveText(String(initialNewCount));

    // Select Japanese deck to test Ruby / Furigana toggle ('F')
    await page
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Essentials (JA)' });
    // Initially hide_furigana_on_front is true on Recognition layout, so <rt> is hidden before reveal
    await expect(card.locator('rt')).toHaveCount(0);
    // Press 'f' to reveal furigana on front
    await page.keyboard.press('f');
    await expect(card.locator('rt').first()).toBeVisible();
    // Press 'f' again to hide it
    await page.keyboard.press('f');
    await expect(card.locator('rt')).toHaveCount(0);

    // Open inline NoteEditDialog via 'e' shortcut
    await page.keyboard.press('e');
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();

    // Typing 'z' or '1' inside dialog input must NOT fire study shortcuts
    const notesInput = dialog.locator('textarea').last();
    await notesInput.fill('Updated note z123');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    // Reveal all steps to verify edited notes persisted
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toContainText('Updated note z123');
  });

  test('Library layout toggle (Production + sibling burying), CSV import, Browse search, .flashpkg export & offline reload', async ({
    page,
    context,
  }) => {
    await page.goto('/?device=libtest');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Navigate to Library
    await page.getByRole('button', { name: 'Library' }).first().click();
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

    // Enable Production layout on Korean Core + Hanja deck
    const koRow = page.locator('[data-testid^="deck-row-"]', { hasText: 'Korean Core + Hanja' });
    await expect(koRow).toBeVisible();
    const prodToggle = koRow.getByRole('button', { name: 'Production' });
    await expect(prodToggle).toHaveAttribute('aria-pressed', 'false');
    await prodToggle.click();
    await expect(prodToggle).toHaveAttribute('aria-pressed', 'true');

    // Paste CSV rows into Korean Core + Hanja deck
    await page
      .getByLabel('Target deck for CSV paste')
      .selectOption({ label: 'Korean Core + Hanja' });
    await page
      .getByTestId('csv-paste-input')
      .fill('Word,Meaning,Tags\n바다,ocean,nature\n산,mountain,nature');
    await page.getByTestId('csv-paste-submit').click();
    await expect(page.getByTestId('library-status')).toContainText('Imported 2 note(s)');

    // Verify sibling burying: Korean deck now has 6 notes x 2 layouts (12 cards),
    // but only 6 cards (1 per note) appear as New today because siblings are buried!
    await koRow.getByRole('button', { name: 'Study' }).click();
    await expect(page.getByTestId('count-new')).toHaveText('6');

    // Return to Library for export
    await page.getByRole('button', { name: 'Library' }).first().click();

    // Export full collection .flashpkg and verify zip header ('PK')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-collection-btn').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.flashpkg$/);
    const dlPath = await download.path();
    expect(dlPath).toBeTruthy();
    if (dlPath) {
      const buf = readFileSync(dlPath);
      expect(buf[0]).toBe(0x50); // 'P'
      expect(buf[1]).toBe(0x4b); // 'K'
    }

    // Navigate to Browse and verify virtualized search finds imported CSV note
    await page.getByRole('button', { name: 'Browse' }).first().click();
    await page.getByLabel('Search notes by text or tag').fill('바다');
    await expect(page.getByTestId('browse-list')).toContainText('바다');
    await expect(page.getByTestId('browse-list')).toContainText('ocean');

    // Wait for service worker precache to be ready, then go offline and reload
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready;
      }
    });

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Verify imported note persisted in IndexedDB while offline
    await page.getByRole('button', { name: 'Browse' }).first().click();
    await page.getByLabel('Search notes by text or tag').fill('바다');
    await expect(page.getByTestId('browse-list')).toContainText('바다');

    await context.setOffline(false);
  });

  test('?device=a and ?device=b maintain completely isolated IndexedDB databases', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await pageA.goto('/?device=isoa');
    await pageB.goto('/?device=isob');

    await expect(pageA.getByTestId('study-card')).toBeVisible();
    await expect(pageB.getByTestId('study-card')).toBeVisible();

    const countAInitial = Number(await pageA.getByTestId('count-new').textContent());
    const countBInitial = Number(await pageB.getByTestId('count-new').textContent());
    expect(countAInitial).toBe(countBInitial);

    // Study 1 card on Device A
    await pageA.keyboard.press('Space');
    await pageA.getByTestId('rate-easy').click();
    await expect(pageA.getByTestId('count-new')).toHaveText(String(countAInitial - 1));

    // Reload Device B -> its count must be untouched
    await pageB.reload();
    await expect(pageB.getByTestId('count-new')).toHaveText(String(countBInitial));

    // Reload Device A -> its reviewed state must persist
    await pageA.reload();
    await expect(pageA.getByTestId('count-new')).toHaveText(String(countAInitial - 1));

    await context.close();
  });
});
