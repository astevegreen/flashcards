import { expect, test, type Page } from '@playwright/test';

async function openBrowse(page: Page, device: string): Promise<void> {
  await page.goto(`/?device=${device}`);
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByRole('button', { name: 'Words' }).first().click();
  await expect(page.getByTestId('browse-list')).toBeVisible();
}

/** Drops a CSV on the Bring my cards panel and waits for the column-mapping step. */
async function dropCsv(page: Page, device: string, csv: string): Promise<void> {
  await page.goto(`/?device=${device}`);
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByRole('button', { name: 'Decks' }).first().click();
  await page.getByTestId('import-export-btn').click();
  await expect(page.getByTestId('bring-my-cards-panel')).toBeVisible();
  await page.getByTestId('bring-drop-zone').evaluate((zone, text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], 'words.csv', { type: 'text/csv' }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
  }, csv);
  await expect(page.getByTestId('bring-mapping')).toBeVisible();
}

test.describe('How tags work', () => {
  test('Browse button opens and dismisses the guide', async ({ page }) => {
    await openBrowse(page, 'ptagsguide1');
    await expect(page.getByTestId('tags-guide')).toHaveCount(0);
    await page.getByTestId('open-tags-guide').click();
    const guide = page.getByTestId('tags-guide');
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('Grammar::Particles');
    await expect(guide).toContainText('Tags work like categories');
    await page.getByTestId('tags-guide-dismiss').click();
    await expect(guide).toHaveCount(0);
  });

  test('the Browse guide does not come back when the tag manager closes', async ({ page }) => {
    await openBrowse(page, 'ptagsguide4');
    await page.getByTestId('open-tags-guide').click();
    await expect(page.getByTestId('tags-guide')).toBeVisible();
    // Opening the manager swaps the Browse guide for the manager's own copy.
    await page.getByTestId('open-tag-manager').click();
    const manager = page.getByTestId('tag-manager');
    await expect(manager).toBeVisible();
    await expect(page.getByTestId('tags-guide')).toHaveCount(1);
    await expect(manager.getByTestId('tags-guide')).toHaveCount(1);
    // Inside the manager the guide's heading sits one level below the manager's.
    await expect(manager.getByRole('heading', { level: 3, name: 'How tags work' })).toBeVisible();
    await page.getByTestId('tag-manager-close').click();
    await expect(page.getByTestId('tag-manager')).toHaveCount(0);
    await expect(page.getByTestId('tags-guide')).toHaveCount(0);
  });

  test('tag manager shows it first, remembers dismissal, and can reopen it', async ({ page }) => {
    await openBrowse(page, 'ptagsguide2');
    await page.getByTestId('open-tag-manager').click();
    const manager = page.getByTestId('tag-manager');
    await expect(manager.getByTestId('tags-guide')).toBeVisible();
    await manager.getByTestId('tags-guide-dismiss').click();
    await expect(manager.getByTestId('tags-guide')).toHaveCount(0);

    // Dismissal is remembered on this device.
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Words' }).first().click();
    await page.getByTestId('open-tag-manager').click();
    await expect(page.getByTestId('tag-manager')).toBeVisible();
    await expect(page.getByTestId('tags-guide')).toHaveCount(0);

    // The "How tags work" button brings it back.
    await page.getByTestId('tag-manager-guide').click();
    await expect(page.getByTestId('tags-guide')).toBeVisible();
  });

  test('the guide fits a 320 px phone without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openBrowse(page, 'ptagsguide5');
    await page.getByTestId('open-tag-manager').click();
    const guide = page.getByTestId('tag-manager').getByTestId('tags-guide');
    await expect(guide).toBeVisible();
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await guide.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 320).toBe(true);
    await expect(guide.getByTestId('tags-guide-dismiss')).toBeVisible();
  });

  test('the import mapping step explains that category columns become tags', async ({ page }) => {
    await dropCsv(page, 'ptagsguide3', 'word,definition,category1\n나무,tree,nature\n');
    const hint = page.getByTestId('bring-map-tags-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Category 1');
    await expect(hint).toContainText('Grammar::Particles');
  });

  test('the import tag hint is hidden when no column maps to tags', async ({ page }) => {
    await dropCsv(page, 'ptagsguide6', 'word,definition\n나무,tree\n');
    await expect(page.getByTestId('bring-map-tags-hint')).toHaveCount(0);
  });
});
