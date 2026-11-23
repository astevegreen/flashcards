import { expect, test, type Page } from '@playwright/test';

async function openBrowse(page: Page, device: string): Promise<void> {
  await page.goto(`/?device=${device}`);
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByRole('button', { name: 'Browse' }).first().click();
  await expect(page.getByTestId('browse-list')).toBeVisible();
}

test.describe('How tags work', () => {
  test('Browse button opens and dismisses the guide', async ({ page }) => {
    await openBrowse(page, 'ptagsguide1');
    await expect(page.getByTestId('tags-guide')).toHaveCount(0);
    await page.getByTestId('open-tags-guide').click();
    const guide = page.getByTestId('tags-guide');
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('Grammar::Particles');
    await expect(guide).toContainText('category');
    await page.getByTestId('tags-guide-dismiss').click();
    await expect(guide).toHaveCount(0);
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
    await page.getByRole('button', { name: 'Browse' }).first().click();
    await page.getByTestId('open-tag-manager').click();
    await expect(page.getByTestId('tag-manager')).toBeVisible();
    await expect(page.getByTestId('tags-guide')).toHaveCount(0);

    // The "How tags work" button brings it back.
    await page.getByTestId('tag-manager-guide').click();
    await expect(page.getByTestId('tags-guide')).toBeVisible();
  });

  test('the import mapping step explains that category columns become tags', async ({ page }) => {
    await page.goto('/?device=ptagsguide3');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByTestId('bring-my-cards-btn').click();
    await expect(page.getByTestId('bring-my-cards-panel')).toBeVisible();
    await page.getByTestId('bring-drop-zone').evaluate((zone, text) => {
      const data = new DataTransfer();
      data.items.add(new File([text], 'words.csv', { type: 'text/csv' }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
    }, 'word,definition,category1\n나무,tree,nature\n');
    const hint = page.getByTestId('bring-map-tags-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Grammar::Particles');
  });
});
