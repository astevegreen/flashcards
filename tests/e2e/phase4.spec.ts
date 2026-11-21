import { expect, test } from '@playwright/test';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
} from '../../packages/core/src/events/replay.ts';
import { createHlcState } from '../../packages/core/src/hlc.ts';
import { deriveNoteId } from '../../packages/core/src/ids.ts';
import { exportFlashpkg } from '../../packages/core/src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../../packages/core/src/model/presets.ts';

// Minimal valid 1x1 red PNG for image upload & 2-device media sync tests
const ONE_PX_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function buildBrokenCourseFlashpkg(): Buffer {
  const st = createEmptyState();
  const factory = createEventFactory('pkg-author', 0, createHlcState('pkg-author', 1000));
  const deckId = 'broken-course-deck';
  applyEvents(st, [
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: 'Broken Course Practice Deck',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: 1000,
      },
      1000,
    ),
    factory.create(
      'NoteUpserted',
      {
        note_id: deriveNoteId(deckId, 'n1'),
        deck_id: deckId,
        source_key: 'n1',
        fields: { word: '물', meaning: 'water' },
        tags: [],
        provenance: { source: 'import', reviewed: true },
        created_order: 0,
      },
      1001,
    ),
    factory.create(
      'CourseChanged',
      {
        course: {
          id: 'course:broken-refs',
          name: 'Imported Course With Missing Refs',
          items: [
            { kind: 'page', ref_id: 'page-deleted-ref' },
            { kind: 'deck', ref_id: deckId, unlocks_after_page_id: 'page-deleted-prereq' },
          ],
        },
      },
      1002,
    ),
  ]);
  return Buffer.from(
    exportFlashpkg(st, {
      packageId: 'pkg:broken-course-test',
      name: 'Broken Course Test Package',
      version: '1.0.0',
    }),
  );
}

test.describe('Phase 4 Richer Content, Answer Modes, Media Sync, Pages & Courses E2E', () => {
  test('Typed mode: IME composition guard, live Japanese romaji->kana, diff display, suggested rating & override', async ({
    page,
  }) => {
    await page.goto('/?device=p4typed');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Create & enable a Typed layout on Japanese Essentials (JA) testing Reading field
    await page.getByRole('button', { name: 'Library' }).first().click();
    const jaRow = page.locator('[data-testid^="deck-row-"]', {
      hasText: 'Japanese Essentials (JA)',
    });
    await expect(jaRow).toBeVisible();
    await jaRow.getByRole('button', { name: 'Options' }).click();

    const addForm = jaRow.locator('[data-testid^="add-layout-form-"]');
    await addForm.getByLabel('Answer mode').selectOption('typed');
    await addForm.getByLabel('Layout label').fill('TypedJA');
    await addForm.getByLabel('Prompt field').selectOption('word');
    await addForm.getByLabel('Answer field').selectOption('reading');
    await addForm.locator('[data-testid^="add-layout-submit-"]').click();

    // Disable default Flip Recognition so TypedJA is the active layout on Japanese deck
    await jaRow.getByRole('button', { name: 'Recognition' }).click();
    await jaRow.getByRole('button', { name: 'Study' }).click();

    const card = page.getByTestId('study-card');
    await expect(card).toHaveAttribute('data-answer-mode', 'typed');

    const input = page.getByTestId('typed-answer-input');
    await expect(input).toBeVisible();

    // 1. IME composition guard (§5.2): pressing Enter while composing must NOT submit
    await input.focus();
    await input.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }));
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
      );
    });
    await expect(page.getByTestId('card-back')).toHaveCount(0);

    // End composition
    await input.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    });

    // 2. Typing romaji converts live to hiragana via lazy wanakana & shortcuts ('e', 'z') don't fire
    await input.fill('nihonn');
    await expect(input).toHaveValue('にほん');

    // Submit via Enter -> exact match -> Suggested Good (data-suggested="true")
    await input.press('Enter');
    await expect(page.getByTestId('typed-answer-feedback')).toContainText('Correct');
    await expect(page.getByTestId('rate-good')).toHaveAttribute('data-suggested', 'true');
    // Override with Easy (proves suggested rating is overridable)
    await page.getByTestId('rate-easy').click();

    // 3. Second card: submit wrong answer -> character diff rendered & Again suggested
    const input2 = page.getByTestId('typed-answer-input');
    await expect(input2).toBeVisible();
    await input2.fill('wrong');
    await page.getByTestId('typed-answer-submit').click();
    await expect(page.getByTestId('typed-answer-diff')).toBeVisible();
    await expect(page.getByTestId('rate-again')).toHaveAttribute('data-suggested', 'true');
    await page.getByTestId('rate-again').click();
  });

  test('Choice mode: 4 options rendered, keyboard 1-4 selection, feedback & suggested rating', async ({
    page,
  }) => {
    await page.goto('/?device=p4choice');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Create & enable a Choice layout on Korean Core + Hanja (has 4 notes)
    await page.getByRole('button', { name: 'Library' }).first().click();
    const koRow = page.locator('[data-testid^="deck-row-"]', { hasText: 'Korean Core + Hanja' });
    await koRow.getByRole('button', { name: 'Options' }).click();

    const addForm = koRow.locator('[data-testid^="add-layout-form-"]');
    await addForm.getByLabel('Answer mode').selectOption('choice');
    await addForm.getByLabel('Layout label').fill('Quiz4');
    await addForm.getByLabel('Prompt field').selectOption('word');
    await addForm.getByLabel('Answer field').selectOption('meaning');
    await addForm.locator('[data-testid^="add-layout-submit-"]').click();

    await koRow.getByRole('button', { name: 'Recognition' }).click();
    await koRow.getByRole('button', { name: 'Study' }).click();

    await expect(page.getByTestId('study-card')).toHaveAttribute('data-answer-mode', 'choice');
    const optionsContainer = page.getByTestId('choice-options');
    await expect(optionsContainer.locator('button')).toHaveCount(4);

    // Find which option (1..4) is correct and press its keyboard number!
    let correctKey = '1';
    for (let i = 1; i <= 4; i++) {
      const attr = await page.getByTestId(`choice-option-${i}`).getAttribute('data-correct');
      if (attr === 'true') {
        correctKey = String(i);
        break;
      }
    }
    await page.keyboard.press(correctKey);
    await expect(page.getByTestId('choice-feedback')).toContainText('Correct');
    await expect(page.getByTestId('rate-good')).toHaveAttribute('data-suggested', 'true');
    await page.getByTestId('rate-good').click();
  });

  test('Cloze mode: multi-blank derivation, active blank masked with hint, inactive blank inline, sibling burying', async ({
    page,
  }) => {
    await page.goto('/?device=p4cloze');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Select sample Cloze deck ("Japanese Particles Cloze (JA)")
    await page
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Particles Cloze (JA)' });

    // Deck has 3 notes (note 1 has c1+c2 -> 4 cards total), sibling burying shows 3 new cards today
    await expect(page.getByTestId('count-new')).toHaveText('3');
    await expect(page.getByTestId('study-card')).toHaveAttribute('data-answer-mode', 'cloze');

    // Note 1 c1 card: active blank c1 shows hint [topic], while c2 ("に") is visible inline!
    await expect(page.getByTestId('cloze-blank-c1')).toHaveText('[topic]');
    await expect(page.getByTestId('front-field-text')).toContainText('に');
    await expect(page.getByTestId('cloze-blank-c2')).toHaveCount(0);

    // Flip reveals active blank ("は") highlighted
    await page.keyboard.press('Space');
    await expect(page.getByTestId('cloze-revealed-c1')).toHaveText('は');
    await expect(page.getByTestId('card-back')).toContainText('I am going to Tokyo.');

    // Rate Easy -> note 1's sibling c2 remains buried today; next card is note 2 (repeated c1 blanks!)
    await page.getByTestId('rate-easy').click();
    await expect(page.getByTestId('count-new')).toHaveText('2');
    await expect(page.getByTestId('cloze-blank-c1')).toHaveCount(2);
  });

  test('Image upload in NoteEditDialog, 2-device media sync (?device=mediaa <-> ?device=mediab), and offline display', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await pageA.goto('/?device=mediaa');
    await pageB.goto('/?device=mediab');

    await expect(pageA.getByTestId('study-card')).toBeVisible();
    await expect(pageB.getByTestId('study-card')).toBeVisible();

    // Focus Korean Core + Hanja on both devices
    await pageA.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });

    // Open Edit dialog on Device A and upload PNG image
    await pageA.keyboard.press('e');
    const dialogA = pageA.locator('dialog[open]');
    await expect(dialogA).toBeVisible();

    const [fileChooser] = await Promise.all([
      pageA.waitForEvent('filechooser'),
      dialogA.getByTestId('upload-image-image').click(),
    ]);
    await fileChooser.setFiles({
      name: 'sample.png',
      mimeType: 'image/png',
      buffer: ONE_PX_PNG_BUFFER,
    });

    // Preview image appears in dialog
    await expect(dialogA.getByTestId('media-image')).toBeVisible();
    await dialogA.getByRole('button', { name: 'Save' }).click();
    await expect(dialogA).toHaveCount(0);

    // Flip card on Device A -> uploaded image renders from local IndexedDB blob URL
    await pageA.keyboard.press('Space');
    const imgA = pageA.getByTestId('card-back').getByTestId('media-image');
    await expect(imgA).toBeVisible();
    const imgASrc = await imgA.getAttribute('src');
    expect(imgASrc).toMatch(/^blob:/);

    // Sync Device A -> pushes media/<aa>/<sha256>.png + MediaAdded + NoteUpserted -> Device B pulls live
    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');

    // Sync Device B explicitly to ensure media blob pull completed
    await pageB.getByRole('button', { name: 'Settings' }).first().click();
    await pageB.getByTestId('sync-now-btn').click();
    await expect(pageB.getByTestId('sync-status-pill')).toHaveText('Synced');

    // Go offline on Device B and verify image renders 100% offline from IndexedDB!
    await pageB.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready;
      }
    });
    await context.setOffline(true);

    await pageB.getByRole('button', { name: 'Study' }).first().click();
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await pageB.keyboard.press('Space');
    const imgB = pageB.getByTestId('card-back').getByTestId('media-image');
    await expect(imgB).toBeVisible();
    expect(await imgB.getAttribute('src')).toMatch(/^blob:/);

    await context.setOffline(false);
    await context.close();
  });

  test('Markdown Page directives, raw HTML XSS rejection, PageRead & Course deck unlock', async ({
    page,
  }) => {
    await page.goto('/?device=p4pages');
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Library' }).first().click();
    const coursesPanel = page.getByTestId('courses-panel');
    await expect(coursesPanel).toBeVisible();

    // Sample Course deck (item 1) starts locked until Lesson Page (item 0) is read
    await expect(coursesPanel.getByTestId('course-item-locked-1')).toBeVisible();
    await expect(coursesPanel.getByTestId('course-study-deck-1')).toBeDisabled();

    // Open sample Lesson Page via Course
    await coursesPanel.getByTestId('course-open-page-0').click();
    const viewer = page.getByTestId('page-viewer');
    await expect(viewer).toBeVisible();

    // Verify all §2.3 directives render declaratively
    await expect(viewer.locator('table')).toBeVisible();
    await expect(viewer.locator('rt').first()).toBeVisible();
    await expect(viewer.getByTestId('directive-say')).toBeVisible();
    await expect(viewer.getByTestId('directive-note')).toBeVisible();
    await expect(viewer.getByTestId('directive-warning')).toBeVisible();

    // :::example toggleable translation
    await expect(viewer.getByTestId('directive-example-translation')).toHaveCount(0);
    await viewer.getByTestId('directive-example-toggle').click();
    await expect(viewer.getByTestId('directive-example-translation')).toContainText(
      'I am a student',
    );

    // ::cards inline mini-study widget flip
    await expect(viewer.getByTestId('directive-cards')).toBeVisible();
    await viewer.getByTestId('directive-cards-flip').click();
    await expect(viewer.getByTestId('directive-cards-back')).toBeVisible();

    // ::deck-link visible
    await expect(viewer.getByTestId('directive-deck-link')).toBeVisible();

    // Test XSS rejection in Page Editor (§13): raw <script>, <img onerror>, javascript: URLs stripped & never executed
    await viewer.getByTestId('page-edit-btn').click();
    const editor = page.getByTestId('page-editor');
    await expect(editor).toBeVisible();
    const mdArea = editor.getByTestId('page-editor-markdown');
    const originalMd = await mdArea.inputValue();
    await mdArea.fill(
      `${originalMd}\n\n<script>window.__p4xss = 1;</script>\n<img src="x" onerror="window.__p4xss = 2" />\n[Evil](javascript:alert(3))`,
    );
    await expect(editor.getByTestId('page-editor-warnings')).toBeVisible();
    await editor.getByTestId('page-editor-save').click();

    // Back in PageViewer: confirm zero XSS executed and zero raw <script> / onerror <img> in DOM
    await expect(page.getByTestId('page-viewer')).toBeVisible();
    const xssResult = await page.evaluate(() => ({
      flag: (window as unknown as { __p4xss?: unknown }).__p4xss,
      scriptsInPage: document.querySelectorAll('[data-testid="page-content"] script').length,
      onerrorImgs: document.querySelectorAll('[data-testid="page-content"] img[onerror]').length,
      jsLinks: document.querySelectorAll('[data-testid="page-content"] a[href^="javascript:"]')
        .length,
    }));
    expect(xssResult).toEqual({
      flag: undefined,
      scriptsInPage: 0,
      onerrorImgs: 0,
      jsLinks: 0,
    });

    // Mark page as read -> emits PageRead -> unlocks Course deck!
    await page.getByTestId('mark-page-read-btn').click();
    await expect(page.getByTestId('page-read-badge')).toBeVisible();

    await page.getByTestId('page-back-btn').click();
    await expect(page.getByTestId('course-item-locked-1')).toHaveCount(0);
    await expect(page.getByTestId('course-study-deck-1')).toBeEnabled();

    // Launch unlocked Course deck into Study
    await page.getByTestId('course-study-deck-1').click();
    await expect(page.getByTestId('study-card')).toHaveAttribute('data-answer-mode', 'cloze');
  });

  test('AI Provenance "Needs review" badge, Browse filter toggle, and 1-tap Mark reviewed persistence', async ({
    page,
  }) => {
    await page.goto('/?device=p4ai');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Navigate to Browse and filter by "Needs review"
    await page.getByRole('button', { name: 'Browse' }).first().click();
    const filterBtn = page.getByTestId('needs-review-filter');
    await expect(filterBtn).toContainText('Needs review (1)');
    await filterBtn.click();
    await expect(filterBtn).toHaveAttribute('aria-pressed', 'true');

    // Only the 1 AI-drafted note should be listed with badge + Mark reviewed button
    await expect(page.getByTestId('browse-needs-review-badge')).toHaveCount(1);
    await expect(page.getByTestId('browse-list')).toContainText('猫');

    // Click 1-tap Mark reviewed -> badge clears and count drops to 0
    await page.locator('[data-testid^="browse-mark-reviewed-"]').first().click();
    await expect(filterBtn).toContainText('Needs review (0)');
    await expect(page.getByTestId('browse-needs-review-badge')).toHaveCount(0);

    // Reload and confirm reviewed state persists from IndexedDB
    await page.reload();
    await page.getByRole('button', { name: 'Browse' }).first().click();
    await expect(page.getByTestId('needs-review-filter')).toContainText('Needs review (0)');
  });

  test('Composable typed-cloze, ListenMode (R/S shortcuts), scroll-to-bottom auto-PageRead, and real >1200px image downscaling + spoofed SVG rejection', async ({
    page,
  }) => {
    // Capture speechSynthesis calls so we can verify ListenMode & R/S shortcuts deterministically
    await page.addInitScript(() => {
      const calls: Array<{ text: string; lang: string; rate: number }> = [];
      (window as unknown as { __ttsCalls: typeof calls }).__ttsCalls = calls;
      const origSpeak = window.speechSynthesis?.speak?.bind(window.speechSynthesis);
      if (window.speechSynthesis) {
        window.speechSynthesis.speak = (utterance: SpeechSynthesisUtterance) => {
          calls.push({ text: utterance.text, lang: utterance.lang, rate: utterance.rate });
          if (origSpeak) {
            try {
              origSpeak(utterance);
            } catch {
              // ignore headless audio errors
            }
          }
        };
      }
    });

    await page.goto('/?device=p4extra');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // 1. Composable typed-cloze on Japanese Particles Cloze (JA)
    await page
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Particles Cloze (JA)' });
    await expect(page.getByTestId('cloze-blank-c1')).toBeVisible();
    await page.getByTestId('cloze-toggle-typed').click();
    const clozeInput = page.getByTestId('typed-answer-input');
    await expect(clozeInput).toBeVisible();
    await clozeInput.fill('ha');
    await expect(clozeInput).toHaveValue('は');
    await clozeInput.press('Enter');
    await expect(page.getByTestId('typed-answer-feedback')).toContainText('Correct');
    await expect(page.getByTestId('rate-good')).toHaveAttribute('data-suggested', 'true');

    // 2. ListenMode + R/S shortcuts on Japanese Essentials (JA)
    await page.getByRole('button', { name: 'Library' }).first().click();
    const jaRow = page.locator('[data-testid^="deck-row-"]', {
      hasText: 'Japanese Essentials (JA)',
    });
    await jaRow.getByRole('button', { name: 'Options' }).click();
    const addForm = jaRow.locator('[data-testid^="add-layout-form-"]');
    await addForm.getByLabel('Answer mode').selectOption('listen');
    await addForm.getByLabel('Layout label').fill('ListenJA');
    await addForm.getByLabel('Prompt field').selectOption('word');
    await addForm.locator('[data-testid^="add-layout-submit-"]').click();
    await jaRow.getByRole('button', { name: 'Recognition' }).click();
    await jaRow.getByRole('button', { name: 'Study' }).click();

    await expect(page.getByTestId('study-card')).toHaveAttribute('data-answer-mode', 'listen');
    await expect(page.getByTestId('listen-prompt')).toBeVisible();
    await page.keyboard.press('r');
    await page.keyboard.press('s');
    const ttsCalls = await page.evaluate(
      () =>
        (window as unknown as { __ttsCalls: Array<{ text: string; lang: string; rate: number }> })
          .__ttsCalls,
    );
    expect(ttsCalls.some((c) => c.rate === 1 && c.lang === 'ja-JP')).toBe(true);
    expect(ttsCalls.some((c) => c.rate === 0.75 && c.lang === 'ja-JP')).toBe(true);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();

    // 3. Real > 1200px PNG downscaling + spoofed SVG-as-PNG rejection in NoteEditDialog
    await page.keyboard.press('e');
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();

    // First try uploading a spoofed SVG disguised as image/png -> must show error alert & NOT render image
    const [spoofChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      dialog.getByTestId('upload-image-image').click(),
    ]);
    await spoofChooser.setFiles({
      name: 'spoof.png',
      mimeType: 'image/png',
      buffer: Buffer.from('<svg onload="alert(1)"><rect width="10" height="10"/></svg>'),
    });
    await expect(dialog.getByRole('alert')).toContainText(/valid PNG, JPEG, WebP, or GIF/i);
    await expect(dialog.getByTestId('media-image')).toHaveCount(0);

    // Generate a real 1600x800 PNG in the browser via Canvas and upload it -> downscales to <= 1200px!
    const largePngBase64 = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1600;
      c.height = 800;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#3366cc';
        ctx.fillRect(0, 0, 1600, 800);
      }
      return c.toDataURL('image/png').split(',')[1] ?? '';
    });
    const [largeChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      dialog.getByTestId('upload-image-image').click(),
    ]);
    await largeChooser.setFiles({
      name: 'large-photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from(largePngBase64, 'base64'),
    });
    const previewImg = dialog.getByTestId('media-image');
    await expect(previewImg).toBeVisible();
    await expect
      .poll(async () => previewImg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeLessThanOrEqual(1200);
    const naturalDims = await previewImg.evaluate((el) => ({
      w: (el as HTMLImageElement).naturalWidth,
      h: (el as HTMLImageElement).naturalHeight,
    }));
    expect(naturalDims.w).toBe(1200);
    expect(naturalDims.h).toBe(600);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // 4. Tall scrollable Lesson Page: column-0 inline ::say + scroll-to-bottom automatic PageRead
    await page.getByRole('button', { name: 'Library' }).first().click();
    await page.getByTestId('new-page-btn').click();
    await page.getByTestId('page-editor-title').fill('Tall Scroll Lesson');
    await page.getByTestId('page-editor-slug').fill('tall-scroll-lesson');
    const longParagraphs = Array.from(
      { length: 24 },
      (_, idx) => `Paragraph ${idx + 1}: Japanese particles practice note line.`,
    ).join('\n\n');
    await page
      .getByTestId('page-editor-markdown')
      .fill(`::say[食[た]べます]{lang=ja} starts at column zero.\n\n${longParagraphs}`);
    await page.getByTestId('page-editor-save').click();

    // Must render column-0 inline ::say as a speaker button and remain unread on mount
    const viewer = page.getByTestId('page-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer.getByTestId('directive-say')).toBeVisible();
    await expect(page.getByTestId('page-read-badge')).toHaveCount(0);

    // Actively scroll to bottom -> emits PageRead automatically!
    await page.getByTestId('page-content').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    await expect(page.getByTestId('page-read-badge')).toBeVisible();
  });

  test('Course creation & editing: multi-item add/remove/reorder, prerequisite lock badges, and reload persistence', async ({
    page,
  }) => {
    await page.goto('/?device=p4courses');
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Library' }).first().click();
    const coursesPanel = page.getByTestId('courses-panel');
    await expect(coursesPanel).toBeVisible();

    // 1. Verify existing sample course opens in Edit mode with pre-populated items & prerequisite, then Cancel leaves it intact
    const sampleCard = coursesPanel.locator('[data-testid^="course-card-"]', {
      hasText: 'Japanese Particles Mini-Course',
    });
    await expect(sampleCard).toBeVisible();
    await sampleCard.getByRole('button', { name: 'Edit' }).click();
    const sampleEditor = sampleCard.getByTestId('course-editor-form');
    await expect(sampleEditor).toBeVisible();
    await expect(sampleEditor.getByTestId('course-draft-item-0')).toBeVisible();
    await expect(sampleEditor.getByTestId('course-draft-item-1')).toBeVisible();
    await expect(sampleEditor.getByTestId('course-draft-prereq-1')).not.toHaveValue('');
    await sampleEditor.getByTestId('course-cancel-btn').click();
    await expect(sampleCard.getByTestId('course-editor-form')).toHaveCount(0);

    // 2. Create a multi-item course (validation check, add deck + page + deck, reorder, set prerequisite)
    await coursesPanel.getByTestId('new-course-btn').click();
    const createForm = coursesPanel.getByTestId('course-editor-form');
    await expect(createForm).toBeVisible();

    // Empty title validation shows alert and blocks submit
    await createForm.getByTestId('course-save-btn').click();
    await expect(createForm.getByRole('alert')).toContainText(/course title/i);

    await createForm.getByTestId('course-editor-name').fill('Custom Multi-Step Track');
    await createForm
      .getByTestId('course-editor-description')
      .fill('Read the grammar lesson, then practice two decks.');

    // Add 3 items: Deck -> Page -> Deck
    await createForm.getByTestId('course-add-deck-btn').click();
    await createForm
      .getByTestId('course-draft-ref-0')
      .selectOption({ label: 'Japanese Essentials (JA)' });

    await createForm.getByTestId('course-add-page-btn').click();
    await createForm
      .getByTestId('course-draft-ref-1')
      .selectOption({ label: 'Japanese Particles: は vs が' });

    await createForm.getByTestId('course-add-deck-btn').click();
    await createForm
      .getByTestId('course-draft-ref-2')
      .selectOption({ label: 'Korean Core + Hanja' });

    // Reorder: move Deck at index 0 down so Page moves to index 0
    await createForm.getByTestId('course-draft-down-0').click();
    await expect(createForm.getByTestId('course-draft-item-0')).toContainText(/page/i);
    await expect(createForm.getByTestId('course-draft-item-1')).toContainText(/deck/i);

    // Set prerequisite on item 1 (Japanese Essentials) to the lesson page
    await createForm
      .getByTestId('course-draft-prereq-1')
      .selectOption({ label: 'Japanese Particles: は vs が' });

    await createForm.getByTestId('course-save-btn').click();
    await expect(coursesPanel.getByTestId('course-editor-form')).toHaveCount(0);

    const customCard = coursesPanel.locator('[data-testid^="course-card-"]', {
      hasText: 'Custom Multi-Step Track',
    });
    await expect(customCard).toBeVisible();
    await expect(customCard.getByTestId('course-item-page-0')).toContainText(
      'Japanese Particles: は vs が',
    );
    await expect(customCard.getByTestId('course-item-deck-1')).toContainText(
      'Japanese Essentials (JA)',
    );
    await expect(customCard.getByTestId('course-item-locked-1')).toBeVisible();
    await expect(customCard.getByTestId('course-study-deck-1')).toBeDisabled();
    await expect(customCard.getByTestId('course-item-deck-2')).toContainText('Korean Core + Hanja');
    await expect(customCard.getByTestId('course-study-deck-2')).toBeEnabled();

    // 3. Edit the newly created course: rename, clear description, remove item 1, add Cloze deck, reorder, set prerequisite
    await customCard.getByRole('button', { name: 'Edit' }).click();
    const editForm = customCard.getByTestId('course-editor-form');
    await expect(editForm).toBeVisible();

    await editForm.getByTestId('course-editor-name').fill('Custom Multi-Step Track v2');
    await editForm.getByTestId('course-editor-description').fill('');

    // Remove item 1 (Japanese Essentials) -> leaves [Page (0), Korean Core + Hanja (1)]
    await editForm.getByTestId('course-draft-remove-1').click();
    await expect(editForm.locator('[data-testid^="course-draft-item-"]')).toHaveCount(2);

    // Add Cloze deck at index 2, then move it up to index 1 and lock it behind the lesson page
    await editForm.getByTestId('course-add-deck-btn').click();
    await editForm
      .getByTestId('course-draft-ref-2')
      .selectOption({ label: 'Japanese Particles Cloze (JA)' });
    await editForm.getByTestId('course-draft-up-2').click();
    await editForm
      .getByTestId('course-draft-prereq-1')
      .selectOption({ label: 'Japanese Particles: は vs が' });

    await editForm.getByTestId('course-save-btn').click();
    await expect(coursesPanel.getByTestId('course-editor-form')).toHaveCount(0);

    const editedCard = coursesPanel.locator('[data-testid^="course-card-"]', {
      hasText: 'Custom Multi-Step Track v2',
    });
    await expect(editedCard).toBeVisible();
    await expect(editedCard).not.toContainText('Read the grammar lesson');
    await expect(editedCard.getByTestId('course-item-page-0')).toContainText(
      'Japanese Particles: は vs が',
    );
    await expect(editedCard.getByTestId('course-item-deck-1')).toContainText(
      'Japanese Particles Cloze (JA)',
    );
    await expect(editedCard.getByTestId('course-item-locked-1')).toBeVisible();
    await expect(editedCard.getByTestId('course-study-deck-1')).toBeDisabled();
    await expect(editedCard.getByTestId('course-item-deck-2')).toContainText('Korean Core + Hanja');
    await expect(editedCard.getByTestId('course-study-deck-2')).toBeEnabled();

    // 4. Reload and confirm edited course order, title, and prerequisite lock persist from IndexedDB
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Library' }).first().click();

    const persistedCard = page
      .getByTestId('courses-panel')
      .locator('[data-testid^="course-card-"]', {
        hasText: 'Custom Multi-Step Track v2',
      });
    await expect(persistedCard).toBeVisible();
    await expect(persistedCard.getByTestId('course-item-page-0')).toContainText(
      'Japanese Particles: は vs が',
    );
    await expect(persistedCard.getByTestId('course-item-deck-1')).toContainText(
      'Japanese Particles Cloze (JA)',
    );
    await expect(persistedCard.getByTestId('course-item-locked-1')).toBeVisible();
    await expect(persistedCard.getByTestId('course-study-deck-1')).toBeDisabled();
    await expect(persistedCard.getByTestId('course-item-deck-2')).toContainText(
      'Korean Core + Hanja',
    );
    await expect(persistedCard.getByTestId('course-study-deck-2')).toBeEnabled();
  });

  test('Course edge cases: prerequisite cycle guard, missing page/prerequisite badges & recovery', async ({
    page,
  }) => {
    await page.goto('/?device=p4courseedge');
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Library' }).first().click();

    // 1. Create two extra lesson pages so we can test 2-node prerequisite cycle prevention & submit validation
    for (const [title, slug] of [
      ['Cycle Page B', 'cycle-page-b'],
      ['Cycle Page C', 'cycle-page-c'],
    ] as const) {
      await page.getByTestId('new-page-btn').click();
      await page.getByTestId('page-editor-title').fill(title);
      await page.getByTestId('page-editor-slug').fill(slug);
      await page.getByTestId('page-editor-markdown').fill(`# ${title}\n\nLesson body.`);
      await page.getByTestId('page-editor-save').click();
      await expect(page.getByTestId('page-viewer')).toBeVisible();
      await page.getByTestId('page-back-btn').click();
    }

    const coursesPanel = page.getByTestId('courses-panel');
    await coursesPanel.getByTestId('new-course-btn').click();
    const form = coursesPanel.getByTestId('course-editor-form');
    await form.getByTestId('course-editor-name').fill('Cycle Guard Course');

    // Add 2 pages: Item 0 = Japanese Particles (A), Item 1 = Cycle Page B (B)
    await form.getByTestId('course-add-page-btn').click();
    await form
      .getByTestId('course-draft-ref-0')
      .selectOption({ label: 'Japanese Particles: は vs が' });
    await form.getByTestId('course-add-page-btn').click();
    await form.getByTestId('course-draft-ref-1').selectOption({ label: 'Cycle Page B' });

    // Set A -> unlocks after B
    await form.getByTestId('course-draft-prereq-0').selectOption({ label: 'Cycle Page B' });

    // Direct 2-node cycle prevention: Item 1 (B) must NOT offer A as a prerequisite option
    const item1PrereqLabels = await form
      .getByTestId('course-draft-prereq-1')
      .locator('option')
      .allTextContents();
    expect(item1PrereqLabels).not.toContain('Japanese Particles: は vs が');

    // Now trigger a cycle via ref_id swap: change Item 1 to C, set C -> A (acyclic C->A->B), then change Item 1 back to B
    await form.getByTestId('course-draft-ref-1').selectOption({ label: 'Cycle Page C' });
    await form
      .getByTestId('course-draft-prereq-1')
      .selectOption({ label: 'Japanese Particles: は vs が' });
    await form.getByTestId('course-draft-ref-1').selectOption({ label: 'Cycle Page B' });

    // Submit must block with inline alert and keep form open
    await form.getByTestId('course-save-btn').click();
    await expect(form.getByTestId('course-editor-items-error')).toContainText(
      /circular prerequisite/i,
    );
    await expect(form).toBeVisible();

    // Break the cycle and save cleanly
    await form.getByTestId('course-draft-prereq-1').selectOption('');
    await form.getByTestId('course-save-btn').click();
    await expect(coursesPanel.getByTestId('course-editor-form')).toHaveCount(0);

    // 2. Import a .flashpkg containing a course with a missing page ref & missing prerequisite page
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-flashpkg-btn').click(),
    ]);
    await fileChooser.setFiles({
      name: 'broken-course.flashpkg',
      mimeType: 'application/zip',
      buffer: buildBrokenCourseFlashpkg(),
    });

    const brokenCard = coursesPanel.locator('[data-testid^="course-card-"]', {
      hasText: 'Imported Course With Missing Refs',
    });
    await expect(brokenCard).toBeVisible();
    // Missing page item renders explicit Missing page badge and disables Read Lesson
    await expect(brokenCard.getByTestId('course-item-missing-0')).toHaveText('Missing page');
    await expect(brokenCard.getByTestId('course-open-page-0')).toBeDisabled();

    // Deck with missing prerequisite shows Missing prerequisite page badge, disables Study Deck, and hides broken Read Prerequisite button
    await expect(brokenCard.getByTestId('course-item-locked-1')).toContainText(
      /Missing prerequisite page/i,
    );
    await expect(brokenCard.getByTestId('course-study-deck-1')).toBeDisabled();
    await expect(brokenCard.getByTestId('course-read-prereq-1')).toHaveCount(0);

    // Edit preserves missing fallback <option> values, then lets the user fix both references cleanly
    await brokenCard.getByRole('button', { name: 'Edit' }).click();
    const repairForm = brokenCard.getByTestId('course-editor-form');
    await expect(repairForm.getByTestId('course-draft-ref-0')).toHaveValue('page-deleted-ref');
    await expect(repairForm.getByTestId('course-draft-prereq-1')).toHaveValue(
      'page-deleted-prereq',
    );

    await repairForm.getByTestId('course-draft-ref-0').selectOption({ label: 'Cycle Page B' });
    await repairForm.getByTestId('course-draft-prereq-1').selectOption('');
    await repairForm.getByTestId('course-save-btn').click();

    await expect(brokenCard.getByTestId('course-item-missing-0')).toHaveCount(0);
    await expect(brokenCard.getByTestId('course-item-locked-1')).toHaveCount(0);
    await expect(brokenCard.getByTestId('course-open-page-0')).toBeEnabled();
    await expect(brokenCard.getByTestId('course-study-deck-1')).toBeEnabled();
  });

  test('Course edits converge across 2-device live sync (?device=coursea <-> ?device=courseb)', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await pageA.goto('/?device=coursea');
    await pageB.goto('/?device=courseb');

    await expect(pageA.getByTestId('study-card')).toBeVisible();
    await expect(pageB.getByTestId('study-card')).toBeVisible();

    // Edit sample course on Device A: rename, add Korean deck, reorder to index 1
    await pageA.getByRole('button', { name: 'Library' }).first().click();
    const cardA = pageA
      .getByTestId('courses-panel')
      .locator('[data-testid^="course-card-"]', { hasText: 'Japanese Particles Mini-Course' });
    await expect(cardA).toBeVisible();
    await cardA.getByRole('button', { name: 'Edit' }).click();

    const editFormA = cardA.getByTestId('course-editor-form');
    await editFormA.getByTestId('course-editor-name').fill('Synced Particles Track');
    await editFormA.getByTestId('course-add-deck-btn').click();
    await editFormA
      .getByTestId('course-draft-ref-2')
      .selectOption({ label: 'Korean Core + Hanja' });
    await editFormA.getByTestId('course-draft-up-2').click();
    await editFormA.getByTestId('course-save-btn').click();

    // Sync Device A -> Device B
    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');

    await pageB.getByRole('button', { name: 'Settings' }).first().click();
    await pageB.getByTestId('sync-now-btn').click();
    await expect(pageB.getByTestId('sync-status-pill')).toHaveText('Synced');

    // Verify Device B Library shows the edited course with matching title, order, and lock badge
    await pageB.getByRole('button', { name: 'Library' }).first().click();
    const cardB = pageB
      .getByTestId('courses-panel')
      .locator('[data-testid^="course-card-"]', { hasText: 'Synced Particles Track' });
    await expect(cardB).toBeVisible();
    await expect(cardB.getByTestId('course-item-page-0')).toContainText(
      'Japanese Particles: は vs が',
    );
    await expect(cardB.getByTestId('course-item-deck-1')).toContainText('Korean Core + Hanja');
    await expect(cardB.getByTestId('course-study-deck-1')).toBeEnabled();
    await expect(cardB.getByTestId('course-item-deck-2')).toContainText(
      'Japanese Particles Cloze (JA)',
    );
    await expect(cardB.getByTestId('course-item-locked-2')).toBeVisible();
    await expect(cardB.getByTestId('course-study-deck-2')).toBeDisabled();

    await context.close();
  });
});
