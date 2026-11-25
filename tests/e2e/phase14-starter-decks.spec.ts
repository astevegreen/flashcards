import { expect, test } from '@playwright/test';
import { STARTER_CATALOG } from '../../packages/core/src/starters/generated/catalog.ts';

/**
 * Phase 14 curated starter decks. A fresh device (production preview, no `?device=`) offers
 * onboarding; each language's first deck is its open-data starter deck, or the built-in sample
 * deck for languages no open source covers yet. Picking it reaches a study card from that deck.
 * No card reveals a licence credit: each deck credits its sources at deck level (its description
 * and Settings > About & Open Data Licenses). A starter deck is the user's own (native) deck in the
 * Library, not a linked package.
 */

interface LanguageCase {
  language: string;
  /** The deck onboarding lists first for the language. */
  deckName: string;
  starter?: { slug: string; noteCount: number };
}

function starterCase(language: string): LanguageCase {
  const info = STARTER_CATALOG.find((d) => d.language === language);
  if (!info) throw new Error(`no starter deck for ${language}`);
  return {
    language,
    deckName: info.name,
    starter: { slug: info.slug, noteCount: info.noteCount },
  };
}

/** What a per-card source credit looked like before 1.2.0 (it must never be revealed again). */
const CARD_CREDIT = /KOGL|CC0|Wikidata|Unihan|Unicode License|edited by this app/;

const CASES: readonly LanguageCase[] = [
  starterCase('ko'),
  // No Japanese source passed the licence gate (JMdict/KANJIDIC2 are share-alike): sample deck.
  { language: 'ja', deckName: 'Japanese Essentials (JA)' },
  starterCase('zh-Hans'),
  { language: 'en', deckName: 'English Idioms (EN)' },
];

test.describe('Phase 14 starter decks in first-run onboarding', () => {
  for (const c of CASES) {
    test(`${c.language}: a fresh device picks its first deck and studies it`, async ({ page }) => {
      await page.goto('/');
      const onboarding = page.getByTestId('onboarding');
      await onboarding.getByTestId(`onboarding-language-${c.language}`).click();
      await expect(onboarding.getByRole('heading', { name: 'Pick a starter deck' })).toBeVisible();

      const first = onboarding.getByTestId(/^onboarding-deck-/).first();
      if (c.starter) {
        await expect(first).toHaveAttribute('data-testid', `onboarding-deck-${c.starter.slug}`);
        await expect(first).toContainText(`${c.starter.noteCount} notes`);
        // The language's built-in sample decks are no longer offered.
        await expect(onboarding.getByTestId(/^onboarding-deck-sample-/)).toHaveCount(0);
      }
      await expect(first).toContainText(c.deckName);
      await first.click();

      const card = page.getByTestId('study-card');
      await expect(card).toBeVisible();
      await expect(page.getByTestId('onboarding')).toHaveCount(0);
      await expect(page.getByLabel('Select deck to study').locator('option')).toHaveText([
        'All Decks',
        c.deckName,
      ]);
      if (!c.starter) return;

      // Reveal every step: the meaning is there, but no licence credit.
      await page.keyboard.press('Space');
      await page.keyboard.press('Space');
      const back = page.getByTestId('card-back');
      await expect(back).toBeVisible();
      await expect(back).not.toContainText(CARD_CREDIT);

      // The deck's sources are credited in About & Open Data Licenses instead.
      await page.getByRole('button', { name: 'Settings' }).first().click();
      const credits = page.getByTestId('starter-deck-credits');
      for (const source of STARTER_CATALOG.find((d) => d.slug === c.starter?.slug)?.sources ?? []) {
        await expect(credits).toContainText(source.name);
      }

      // The Library row shows the whole deck as the user's own deck (no linked-source badge).
      await page.getByRole('button', { name: 'Decks' }).first().click();
      const row = page.locator('[data-testid^="deck-row-"]').filter({ hasText: c.deckName });
      await expect(row).toContainText(`${c.starter.noteCount} notes`);
      await expect(row).not.toContainText('Package');
    });
  }

  test('the starter-deck step fits a 320 px phone without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    for (const c of CASES.filter((x) => x.starter)) {
      await page.getByTestId(`onboarding-language-${c.language}`).click();
      await expect(page.getByTestId(/^onboarding-deck-/).first()).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.getByRole('button', { name: 'Back' }).click();
    }
  });
});
