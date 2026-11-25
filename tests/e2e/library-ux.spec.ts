import { expect, test } from '@playwright/test';

test.describe('Decks & Words UX (library-ux)', () => {
  test('uses Decks / Words / My words labels with subtitles and View words deck filter', async ({
    page,
  }) => {
    await page.goto('/?device=libux1');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Primary nav labels
    await expect(page.getByRole('button', { name: 'Decks' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Words' }).first()).toBeVisible();

    // Decks screen title & subtitle
    await page.getByRole('button', { name: 'Decks' }).first().click();
    await expect(page.getByRole('heading', { name: 'Decks', exact: true })).toBeVisible();
    await expect(
      page.getByText('Your decks: create, organize, set options, import and export.'),
    ).toBeVisible();

    // "View words" on a specific deck switches to Words filtered to that deck
    const koRow = page.locator('[data-testid^="deck-row-"]', { hasText: 'Korean Core + Hanja' });
    await koRow.getByRole('button', { name: 'View words' }).click();

    await expect(page.locator('h1', { hasText: 'Words' })).toBeVisible();
    await expect(
      page.getByText('Every word in your decks: search, edit, tag and clean up.'),
    ).toBeVisible();
    await expect(page.getByTestId('browse-tab-notes')).toHaveText('My words');
    await expect(page.getByLabel('Filter by deck')).not.toHaveValue('');
    await expect(page.getByTestId('browse-list')).toContainText('학교');
  });

  test('unified Import / Export panel supports keyboard toggle, per-deck Export… shortcut, and Settings link', async ({
    page,
  }) => {
    await page.goto('/?device=libux2');
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Decks' }).first().click();

    // Single header button replaces the old 4 buttons
    const toggleBtn = page.getByTestId('import-export-btn');
    await expect(toggleBtn).toHaveText('Import / Export');
    await toggleBtn.click();

    const importTab = page.getByTestId('import-export-tab-import');
    const exportTab = page.getByTestId('import-export-tab-export');
    await expect(importTab).toHaveAttribute('aria-selected', 'true');
    await expect(exportTab).toHaveAttribute('aria-selected', 'false');

    // Keyboard navigation between Import and Export tabs
    await importTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(exportTab).toHaveAttribute('aria-selected', 'true');
    await expect(exportTab).toBeFocused();
    await expect(page.getByTestId('export-collection-btn')).toBeVisible();
    await expect(page.getByTestId('export-deck-select')).toBeVisible();

    await page.keyboard.press('ArrowLeft');
    await expect(importTab).toHaveAttribute('aria-selected', 'true');
    await expect(importTab).toBeFocused();

    // Close panel, then use per-deck "Export…" shortcut in Deck Options
    await page.getByTestId('import-export-close-btn').click();
    await expect(page.getByTestId('import-export-panel')).toHaveCount(0);

    const jpRow = page.locator('[data-testid^="deck-row-"]', {
      hasText: 'Japanese Essentials (JA)',
    });
    await jpRow.getByRole('button', { name: 'Options' }).click();
    await jpRow.locator('[data-testid^="export-deck-shortcut-"]').click();

    await expect(exportTab).toHaveAttribute('aria-selected', 'true');
    const selectedLabel = await page
      .getByTestId('export-deck-select')
      .evaluate((el: HTMLSelectElement) => el.options[el.selectedIndex]?.text ?? '');
    expect(selectedLabel).toBe('Japanese Essentials (JA)');

    const [deckDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-deck-btn').click(),
    ]);
    expect(deckDownload.suggestedFilename()).toBe('japanese-essentials-ja.flashpkg');

    // Settings › Local Backup points to Decks › Import / Export and navigates there on Export tab
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Restore .flashpkg' })).toHaveCount(0);
    await page.getByTestId('settings-open-import-export-btn').click();
    await expect(page.getByRole('heading', { name: 'Decks', exact: true })).toBeVisible();
    await expect(page.getByTestId('import-export-tab-export')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
