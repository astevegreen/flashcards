import { expect, test, type Page } from '@playwright/test';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
} from '../../packages/core/src/events/replay.ts';
import { createHlcState } from '../../packages/core/src/hlc.ts';
import { deriveNoteId } from '../../packages/core/src/ids.ts';
import { exportFlashpkg } from '../../packages/core/src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../../packages/core/src/model/presets.ts';
import { addTestOverrides } from './helpers/test-overrides.ts';

async function waitForOfflinePrecacheReady(page: Page): Promise<void> {
  const hasController = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return true;
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  });
  if (!hasController) {
    await page.reload();
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready;
      }
    });
  }
}

function buildStarterDeckFlashpkg(): Buffer {
  const st = createEmptyState();
  const factory = createEventFactory('starter-author', 0, createHlcState('starter-author', 1000));
  const deckId = 'starter-hanja-101';
  applyEvents(st, [
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: 'Starter Hanja 101',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.HANJA,
        language: 'ko',
        created_at: 1000,
      },
      1000,
    ),
    factory.create(
      'NoteUpserted',
      {
        note_id: deriveNoteId(deckId, 'h-1'),
        deck_id: deckId,
        source_key: 'h-1',
        fields: {
          character: '一',
          eumhun: '한 일',
          meaning: 'one',
          compounds: '一日 (일일)',
        },
        tags: ['starter', 'hanja'],
        provenance: { source: 'import', reviewed: true },
        created_order: 0,
      },
      1001,
    ),
  ]);
  return Buffer.from(
    exportFlashpkg(st, {
      packageId: 'pkg:starter-hanja-101',
      name: 'Starter Hanja 101',
      version: '1.0.0',
    }),
  );
}

test.describe('Phase 6 Drawing, Offline Dictionaries & Built-in Starter Catalog E2E', () => {
  test('Graded draw mode (ja KanjiVG & zh-Hans MMAH): per-deck pre-cache, offline study, canvas controls, FSRS suggestion & override', async ({
    page,
    context,
  }) => {
    await page.goto('/?device=p6draw');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await waitForOfflinePrecacheReady(page);

    // 1. Open Library -> Japanese Essentials (JA) -> enable built-in Draw layout & pre-cache strokes
    await page.getByRole('button', { name: 'Decks' }).first().click();
    const jaRow = page.locator('[data-testid^="deck-row-"]', {
      hasText: 'Japanese Essentials (JA)',
    });
    await expect(jaRow).toBeVisible();

    // Toggle built-in `Draw` layout ON and `Recognition` OFF
    await jaRow.getByRole('button', { name: 'Draw', exact: true }).click();
    await jaRow.getByRole('button', { name: 'Recognition', exact: true }).click();

    // Expand Options and pre-cache Japanese KanjiVG strokes from local /packs/ fixtures
    await jaRow.getByRole('button', { name: 'Options' }).click();
    const strokeBox = jaRow.locator('[data-testid^="deck-stroke-cache-"]');
    await expect(strokeBox).toBeVisible();
    await expect(strokeBox).toContainText('JA · KanjiVG');
    await strokeBox.getByTestId('precache-deck-strokes-btn').click();
    await expect(strokeBox.getByTestId('deck-stroke-coverage')).toContainText('Cached', {
      timeout: 10_000,
    });

    // 2. Also enable Draw layout on Mandarin Basics (ZH) and add a simple 1-stroke `一` card via CSV paste
    const zhRow = page.locator('[data-testid^="deck-row-"]', {
      hasText: 'Mandarin Basics (ZH)',
    });
    await zhRow.getByRole('button', { name: 'Draw', exact: true }).click();
    await zhRow.getByRole('button', { name: 'Recognition', exact: true }).click();
    await zhRow.getByRole('button', { name: 'Options' }).click();
    const zhStrokeBox = zhRow.locator('[data-testid^="deck-stroke-cache-"]');
    await expect(zhStrokeBox).toContainText('ZH · Make Me a Hanzi');
    await zhStrokeBox.getByTestId('precache-deck-strokes-btn').click();
    await expect(zhStrokeBox.getByTestId('deck-stroke-coverage')).toContainText('Cached', {
      timeout: 10_000,
    });

    // Study Japanese Essentials (JA) in offline mode
    await context.setOffline(true);
    await jaRow.getByRole('button', { name: 'Study' }).click();
    const card = page.getByTestId('study-card');
    await expect(card).toHaveAttribute('data-answer-mode', 'draw');

    // Verify Hanzi Writer loads cleanly offline once pre-cached
    const quizPanel = page.getByTestId('draw-quiz-panel');
    await expect(quizPanel).toBeVisible({ timeout: 10_000 });
    await expect(quizPanel).toHaveAttribute('data-stroke-script', 'ja');

    // Verify touch-action: none on drawing target (§6.4)
    const writerTarget = page.getByTestId('hanzi-writer-target');
    await expect(writerTarget).toHaveCSS('touch-action', 'none');

    // Test Grid guide toggle, Outline hint toggle, Clear, and Reveal
    await expect(writerTarget).toHaveAttribute('data-grid-mode', 'star');
    await page.getByTestId('draw-grid-toggle').click();
    await expect(writerTarget).toHaveAttribute('data-grid-mode', 'cross');
    await page.getByTestId('draw-outline-toggle').click();
    await expect(page.getByTestId('draw-outline-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('draw-clear').click();

    // Reveal immediately suggests Again (1), which user can override with Good (3)
    await page.getByTestId('draw-reveal-btn').click();
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(page.getByTestId('rate-again')).toHaveAttribute('data-suggested', 'true');
    await expect(page.getByTestId('draw-animate-btn')).toBeVisible();

    // Override suggestion by tapping Good, then test lossless Undo
    await page.getByTestId('rate-good').click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('draw-quiz-panel')).toBeVisible();

    await context.setOffline(false);
  });

  test('Offline dictionaries, About & Licenses, Hanja Draw-to-Lookup, bidirectional search & quick Add-to-Deck', async ({
    page,
    context,
  }) => {
    await page.goto('/?device=p6dict');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // 1. Go to Settings -> verify Drawing mode settings, About & Licenses, and install Hanja + ZH/Hanja stroke packs
    await page.getByRole('button', { name: 'Settings' }).first().click();

    // Verify per-language drawing mode selector persists across reload
    const koModeSelect = page.getByTestId('drawing-mode-select-ko');
    await expect(koModeSelect).toHaveValue('lookup');
    const jaModeSelect = page.getByTestId('drawing-mode-select-ja');
    await expect(jaModeSelect).toHaveValue('graded');
    await jaModeSelect.selectOption('lookup');

    // Verify About & Data Licenses attribution entries (§6.3, ADR 0001 Spike 0.6)
    const licensesCard = page.getByTestId('about-licenses-card');
    await expect(licensesCard).toBeVisible();
    await expect(licensesCard).toContainText('Unicode License v3');
    await expect(licensesCard).toContainText('CC BY-SA 4.0');
    await expect(licensesCard).toContainText('CC BY-SA 3.0');
    await expect(licensesCard).toContainText('Arphic Public License (1999)');
    await expect(licensesCard).toContainText('MIT License');

    // Install Hanja (Unihan) dictionary pack & Make Me a Hanzi stroke pack from local /packs/packs.json
    await expect(page.getByTestId('pack-row-dict-hanja-unihan')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('pack-install-btn-dict-hanja-unihan').click();
    await expect(page.getByTestId('pack-installed-badge-dict-hanja-unihan')).toBeVisible({
      timeout: 10_000,
    });

    await page.getByTestId('pack-install-btn-strokes-zh-mmah').click();
    await expect(page.getByTestId('pack-installed-badge-strokes-zh-mmah')).toBeVisible({
      timeout: 10_000,
    });

    // Reload and verify drawing_modes preference + installed packs persisted
    await page.reload();
    await waitForOfflinePrecacheReady(page);
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('drawing-mode-select-ja')).toHaveValue('lookup');
    await expect(page.getByTestId('pack-installed-badge-dict-hanja-unihan')).toBeVisible({
      timeout: 10_000,
    });

    // 2. Go OFFLINE and open Browse -> Dictionary & Draw
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Words' }).first().click();
    await page.getByTestId('browse-tab-dictionary').click();
    await expect(page.getByTestId('dictionary-panel')).toBeVisible();

    // Bidirectional English lookup (works offline for terms independent of decks)
    const dictInput = page.getByTestId('dictionary-search-input');
    await dictInput.fill('Korea');
    await expect(page.getByTestId('dict-entry-韓')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('dict-entry-韓')).toContainText('나라 한');

    // Target reading (Hangul) lookup
    await dictInput.fill('학');
    await expect(page.getByTestId('dict-entry-學')).toBeVisible({ timeout: 5_000 });

    // 3. Draw-to-Lookup offline: draw horizontal stroke `一` on PointerInkCanvas
    await page.getByTestId('dictionary-toggle-draw').click();
    const inkCanvas = page.getByTestId('browse-draw-lookup-canvas');
    await expect(inkCanvas).toBeVisible();
    await expect(inkCanvas).toHaveCSS('touch-action', 'none');

    const box = await inkCanvas.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      await page.mouse.move(box.x + 30, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
    }

    // Recognized candidate `一` appears; tap it to view offline Unihan Hanja definition
    const candOne = page.getByTestId('browse-draw-lookup-candidate-一');
    await expect(candOne).toBeVisible({ timeout: 5_000 });
    await candOne.click();
    await expect(dictInput).toHaveValue('一');
    await expect(page.getByTestId('dict-entry-一')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('dict-entry-一')).toContainText('한 일');

    // 4. Quick 1-2 tap "+ Add to Deck" from Dictionary entry
    await page.getByTestId('dict-add-btn-一').click();
    await expect(page.getByTestId('dict-add-bar-一')).toBeVisible();
    await page.getByTestId('dict-add-confirm-btn').click();
    await expect(page.getByTestId('dict-added-banner')).toContainText('Added “一”');
    await expect(page.getByTestId('dict-in-deck-一')).toBeVisible();

    // Switch back to Notes tab and confirm the new note exists in Browse
    await page.getByTestId('browse-tab-notes').click();
    await page.getByLabel('Search notes by text or tag').fill('한 일');
    await expect(page.getByTestId('browse-list')).toContainText('한 일');

    await context.setOffline(false);
  });

  test('Built-in Starter Decks catalog (VITE_STARTER_CATALOG_URL): 1-tap install without Google Drive', async ({
    page,
    context,
  }) => {
    const pkgBytes = buildStarterDeckFlashpkg();
    const starterCatalogUrl = 'https://starter.example.test/index.json';
    const starterPkgUrl = 'https://starter.example.test/starter-hanja-101.flashpkg';

    await page.route(starterCatalogUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { etag: '"starter-v1"' },
        body: JSON.stringify({
          format_version: 1,
          name: 'Official Starter Decks',
          description: 'Curated beginner decks ready in one tap.',
          packages: [
            {
              package_id: 'pkg:starter-hanja-101',
              title: 'Starter Hanja 101',
              description: 'Essential beginner Hanja characters.',
              url: starterPkgUrl,
              version: '1.0.0',
              languages: ['ko'],
            },
          ],
        }),
      });
    });

    await page.route(starterPkgUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/zip',
        body: pkgBytes,
      });
    });

    await addTestOverrides(page, { starterCatalog: starterCatalogUrl });
    await page.goto('/?device=p6starter');
    await expect(page.getByTestId('study-card')).toBeVisible();

    await page.getByRole('button', { name: 'Decks' }).first().click();
    const starterSection = page.getByTestId('starter-decks-section');
    await expect(starterSection).toBeVisible({ timeout: 10_000 });
    await expect(starterSection).toContainText('Official Starter Decks');

    // 1-tap Install without connecting Google Drive or Dropbox
    await page.getByTestId('starter-install-pkg:starter-hanja-101').click();
    const installedDeckRow = page.locator('[data-testid^="deck-row-"]', {
      hasText: 'Starter Hanja 101',
    });
    await expect(installedDeckRow).toBeVisible({ timeout: 10_000 });

    // Confirm offline study works immediately on the installed starter deck
    await context.setOffline(true);
    await installedDeckRow.getByRole('button', { name: 'Study' }).click();
    await expect(page.getByTestId('study-card')).toContainText('一');
    await context.setOffline(false);
  });
});
