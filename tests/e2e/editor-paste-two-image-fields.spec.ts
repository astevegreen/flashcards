import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
} from '../../packages/core/src/events/replay.ts';
import { createHlcState } from '../../packages/core/src/hlc.ts';
import { deriveNoteId } from '../../packages/core/src/ids.ts';
import { exportFlashpkg } from '../../packages/core/src/import/flashpkg.ts';

/**
 * A note type with two image fields: a paste or drop on a field's drop zone goes to that field;
 * an image anywhere else in the editor is ignored (only a note type with exactly one image field
 * takes it). The one-image-field cases are in `editor-paste-image.spec.ts`.
 */

const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DECK = 'two-pics-deck';
const NOTE_TYPE = 'nt-two-pics';
const LAYOUT = 'layout-two-pics';

function buildTwoImagePackage(): Buffer {
  const st = createEmptyState();
  const factory = createEventFactory('pkg-author', 0, createHlcState('pkg-author', 1000));
  applyEvents(st, [
    factory.create(
      'NoteTypeChanged',
      {
        note_type: {
          id: NOTE_TYPE,
          name: 'Two pictures',
          fields: [
            { key: 'word', label: 'Word', kind: 'text', lang: 'ko', sortKey: true },
            { key: 'pic_a', label: 'Picture A', kind: 'image', lang: 'en' },
            { key: 'pic_b', label: 'Picture B', kind: 'image', lang: 'en' },
          ],
        },
      },
      1000,
    ),
    factory.create(
      'LayoutChanged',
      {
        layout: {
          id: LAYOUT,
          note_type_id: NOTE_TYPE,
          name: 'Recognition',
          front_fields: ['word'],
          reveal_steps: [['pic_a', 'pic_b']],
          answer_mode: 'flip',
          hide_furigana_on_front: false,
          enabled: true,
        },
      },
      1000,
    ),
    factory.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: 'Two pics',
        note_type_id: NOTE_TYPE,
        language: 'ko',
        created_at: 1000,
      },
      1000,
    ),
    factory.create(
      'NoteUpserted',
      {
        note_id: deriveNoteId(DECK, 'n1'),
        deck_id: DECK,
        source_key: 'n1',
        fields: { word: '사진' },
        provenance: { source: 'import', reviewed: true },
        created_order: 0,
      },
      1001,
    ),
  ]);
  return Buffer.from(
    exportFlashpkg(st, { packageId: 'pkg:two-pics', name: 'Two pics', version: '1.0.0' }),
  );
}

/** Dispatches a synthetic `paste` or `drop` of one PNG on `target`; returns `defaultPrevented`. */
function transfer(target: Locator, kind: 'paste' | 'drop'): Promise<boolean> {
  return target.evaluate(
    (el, { kind, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      const event =
        kind === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      return !el.dispatchEvent(event);
    },
    { kind, base64: ONE_PX_PNG_BASE64 },
  );
}

async function openEditor(page: Page, device: string): Promise<Locator> {
  await page.goto(`/?device=${device}`);
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByRole('button', { name: 'Library' }).first().click();
  await page.getByTestId('bring-my-cards-btn').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('bring-pick-file-btn').click(),
  ]);
  await chooser.setFiles({
    name: 'two-pics.flashpkg',
    mimeType: 'application/zip',
    buffer: buildTwoImagePackage(),
  });
  await expect(page.getByTestId('bring-flashpkg-status')).toContainText('Imported "Two pics"');
  await page.getByRole('button', { name: 'Study' }).first().click();
  await expect(page.getByTestId('study-card')).toBeVisible();
  await page.getByLabel('Select deck to study').selectOption({ label: 'Two pics' });
  await page.keyboard.press('e');
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('image-drop-pic_a')).toBeVisible();
  await expect(dialog.getByTestId('image-drop-pic_b')).toBeVisible();
  return dialog;
}

test.describe('Paste and drop images into a note with two image fields', () => {
  test('a paste or drop on a field goes to that field only', async ({ page }) => {
    const dialog = await openEditor(page, 'twopicsa');
    const zoneA = dialog.getByTestId('image-drop-pic_a');
    const zoneB = dialog.getByTestId('image-drop-pic_b');

    await transfer(zoneB, 'paste');
    await expect(zoneB.getByTestId('media-image')).toBeVisible();
    await expect(zoneA.getByTestId('media-image')).toHaveCount(0);

    await transfer(zoneA, 'drop');
    await expect(zoneA.getByTestId('media-image')).toBeVisible();
    await expect(zoneB.getByTestId('media-image')).toHaveCount(1);
    await expect(dialog.getByRole('alert')).toHaveCount(0);

    // Both are saved and show on the back of the card.
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back').getByTestId('media-image')).toHaveCount(2);
  });

  test('an image pasted or dropped elsewhere in the editor is ignored', async ({ page }) => {
    const dialog = await openEditor(page, 'twopicsb');
    const word = dialog.getByLabel('Word');
    await word.focus();
    const before = await word.inputValue();

    // Pasted into a text field: left to the browser, nothing is stored.
    expect(await transfer(word, 'paste')).toBe(false);
    // Pasted on the dialog heading, outside any field: not handled either.
    expect(await transfer(dialog.getByRole('heading').first(), 'paste')).toBe(false);
    // Dropped on a text field: ignored, but the browser must not open the file.
    expect(await transfer(word, 'drop')).toBe(true);

    // Processing is asynchronous, so prove nothing landed anywhere by a real paste afterwards:
    // once it has rendered in field A, field B and the dialog hold no other image.
    await transfer(dialog.getByTestId('image-drop-pic_a'), 'paste');
    await expect(dialog.getByTestId('image-drop-pic_a').getByTestId('media-image')).toBeVisible();
    await expect(dialog.getByTestId('image-drop-pic_b').getByTestId('media-image')).toHaveCount(0);
    await expect(dialog.getByTestId('media-image')).toHaveCount(1);
    await expect(word).toHaveValue(before);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog).toBeVisible();
  });
});
