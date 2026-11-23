import { expect, test, type Locator, type Page } from '@playwright/test';

async function openEditor(page: Page, device: string, deck: string): Promise<Locator> {
  await page.goto(`/?device=${device}`);
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByLabel('Select deck to study').selectOption({ label: deck });
  await page.keyboard.press('e');
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function select(field: Locator, start: number, end: number): Promise<void> {
  await field.evaluate(
    (el, [s, e]) => {
      const input = el as HTMLInputElement;
      input.focus();
      input.setSelectionRange(s ?? 0, e ?? 0);
    },
    [start, end],
  );
}

test.describe('Limited rich text in the field editor', () => {
  test('Ctrl+B and a colour button write markup; the card renders it, never as HTML', async ({
    page,
  }) => {
    const dialog = await openEditor(page, 'richa', 'Korean Core + Hanja');
    const field = dialog.locator('[data-testid^="field-input-"]').first();
    const key = ((await field.getAttribute('data-testid')) ?? '').replace('field-input-', '');
    await field.fill('사과 <b>x</b>');

    await select(field, 0, 2);
    await page.keyboard.press('Control+b');
    await expect(field).toHaveValue('{b:사과} <b>x</b>');

    // The selection is the bold content now; a colour wraps it again.
    await dialog.getByTestId(`rich-red-${key}`).click();
    await expect(field).toHaveValue('{b:{red:사과}} <b>x</b>');
    await expect(dialog.getByTestId(`field-preview-${key}`).locator('strong .rich-red')).toHaveText(
      '사과',
    );

    // Toggling the same colour on the same selection removes it again.
    await dialog.getByTestId(`rich-red-${key}`).click();
    await expect(field).toHaveValue('{b:사과} <b>x</b>');
    await dialog.getByTestId(`rich-blue-${key}`).click();
    await expect(field).toHaveValue('{b:{blue:사과}} <b>x</b>');

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    const card = page.getByTestId('study-card');
    await expect(card.locator('strong .rich-blue').first()).toHaveText('사과');
    await expect(card).toContainText('<b>x</b>');
    await expect(card.locator('b')).toHaveCount(0);
  });

  test('a bold cloze answer keeps its blank and is checked as plain text', async ({ page }) => {
    const dialog = await openEditor(page, 'richb', 'Japanese Particles Cloze (JA)');
    const field = dialog.locator('[data-testid^="field-input-"]').first();
    const key = ((await field.getAttribute('data-testid')) ?? '').replace('field-input-', '');
    const preview = dialog.getByTestId(`field-preview-${key}`);

    // Bolding a strict ruby base takes its reading along, so the ruby stays whole.
    await field.fill('学生[がくせい]');
    await select(field, 0, 2);
    await page.keyboard.press('Control+b');
    await expect(field).toHaveValue('{b:学生[がくせい]}');
    await expect(preview.locator('strong ruby rt')).toHaveText('がくせい');

    await field.fill('私{{c1::は}}学生です');
    await select(field, 7, 8);
    await page.keyboard.press('Control+b');
    await expect(field).toHaveValue('私{{c1::{b:は}}}学生です');
    // The preview shows the cloze answer in place, styled.
    await expect(preview.locator('strong')).toHaveText('は');

    // A selection that cuts through the cloze braces is refused with a hint.
    await select(field, 0, 4);
    await page.keyboard.press('Control+b');
    await expect(field).toHaveValue('私{{c1::{b:は}}}学生です');
    await expect(dialog.getByRole('status')).toContainText(/outside ruby/);

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    await expect(page.getByTestId('cloze-blank-c1')).toBeVisible();
    await page.getByTestId('cloze-toggle-typed').click();
    const input = page.getByTestId('typed-answer-input');
    await input.fill('ha');
    await expect(input).toHaveValue('は');
    await input.press('Enter');
    await expect(page.getByTestId('typed-answer-feedback')).toContainText('Correct');
    await expect(page.getByTestId('cloze-revealed-c1').locator('strong')).toHaveText('は');
  });
});
