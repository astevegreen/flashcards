import { expect, test, type Page } from '@playwright/test';

// Minimal valid 1x1 red PNG
const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface TransferFile {
  base64?: string;
  text?: string;
  size?: number;
  name: string;
  type: string;
}

/**
 * Dispatches a synthetic `paste` (or `drop`) carrying one file on `selector`, the way the
 * browser does for a screenshot paste or a file dragged in from the desktop.
 */
async function dispatchTransfer(
  page: Page,
  selector: string,
  kind: 'paste' | 'drop',
  file: TransferFile,
): Promise<void> {
  await page.evaluate(
    ({ selector, kind, file }) => {
      const target = document.querySelector(selector);
      if (!target) throw new Error(`No element for ${selector}`);
      let bytes: Uint8Array;
      if (file.base64) bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      else if (file.text) bytes = new TextEncoder().encode(file.text);
      else bytes = new Uint8Array(file.size ?? 0);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], file.name, { type: file.type }));
      const event =
        kind === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    },
    { selector, kind, file },
  );
}

async function openEditor(page: Page, device: string) {
  await page.goto(`/?device=${device}`);
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
  await page.keyboard.press('e');
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Paste and drop images into the note editor', () => {
  test('pasting on the image field stores it through processImage and saves media:<sha256>', async ({
    page,
  }) => {
    const dialog = await openEditor(page, 'pastea');
    await expect(dialog.getByTestId('media-image')).toHaveCount(0);

    await dispatchTransfer(page, '[data-testid="image-drop-image"]', 'paste', {
      base64: ONE_PX_PNG_BASE64,
      name: 'image.png',
      type: 'image/png',
    });
    await expect(dialog.getByTestId('media-image')).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back').getByTestId('media-image')).toBeVisible();
  });

  test('a screenshot pasted while a text field has focus goes to the only image field', async ({
    page,
  }) => {
    const dialog = await openEditor(page, 'pasteb');
    const firstText = dialog.locator('input[type="text"], textarea').first();
    await firstText.focus();
    const before = await firstText.inputValue();

    await dispatchTransfer(page, 'dialog[open] input[type="text"]', 'paste', {
      base64: ONE_PX_PNG_BASE64,
      name: 'Screenshot.png',
      type: 'image/png',
    });
    await expect(dialog.getByTestId('media-image')).toBeVisible();
    await expect(firstText).toHaveValue(before);
  });

  test('dropping a file uses the same checks: spoofed SVG and oversize files are refused', async ({
    page,
  }) => {
    const dialog = await openEditor(page, 'pastec');

    await dispatchTransfer(page, '[data-testid="image-drop-image"]', 'drop', {
      text: '<svg onload="alert(1)"><rect width="10" height="10"/></svg>',
      name: 'spoof.png',
      type: 'image/png',
    });
    await expect(dialog.getByRole('alert')).toContainText(/valid PNG, JPEG, WebP, or GIF/i);
    await expect(dialog.getByTestId('media-image')).toHaveCount(0);

    await dispatchTransfer(page, '[data-testid="image-drop-image"]', 'drop', {
      size: 21 * 1024 * 1024,
      name: 'huge.png',
      type: 'image/png',
    });
    await expect(dialog.getByRole('alert')).toContainText(/maximum input size \(20 MiB\)/i);

    await dispatchTransfer(page, '[data-testid="image-drop-image"]', 'drop', {
      text: 'not an image',
      name: 'notes.txt',
      type: 'text/plain',
    });
    await expect(dialog.getByRole('alert')).toContainText(/Only PNG, JPEG, WebP, or GIF/i);
    await expect(dialog.getByTestId('media-image')).toHaveCount(0);

    await dispatchTransfer(page, '[data-testid="image-drop-image"]', 'drop', {
      base64: ONE_PX_PNG_BASE64,
      name: 'ok.png',
      type: 'image/png',
    });
    await expect(dialog.getByTestId('media-image')).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  });
});
