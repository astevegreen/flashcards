import { expect, test } from '@playwright/test';

test.describe('Phase 10 Korean dictionary (KRDict starter pack)', () => {
  test('offline Korean lookup: inflected forms, 초성, romanization, English, and Korean entry details', async ({
    page,
    context,
  }) => {
    await page.goto('/?device=p10dict');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Install the KRDict starter pack from the local /packs/packs.json catalog; About shows its licence.
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('about-licenses-card')).toContainText('CC BY-SA 2.0 KR');
    await expect(page.getByTestId('pack-row-dict-krdict')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('pack-install-btn-dict-krdict').click();
    await expect(page.getByTestId('pack-installed-badge-dict-krdict')).toBeVisible({
      timeout: 10_000,
    });

    // Everything below runs offline against IndexedDB. Wait for the service worker precache first,
    // otherwise lazily loaded screens (Browse, DictionaryPanel) can race it under parallel load.
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready;
      }
    });
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Browse' }).first().click();
    await page.getByTestId('browse-tab-dictionary').click();
    await expect(page.getByTestId('dictionary-panel')).toBeVisible();
    const input = page.getByTestId('dictionary-search-input');
    const results = page.getByTestId('dictionary-results');

    // 1. Inflected form → dictionary form, with POS, level, pronunciation, sense source and examples.
    await input.fill('먹었어요');
    const meokda = results.getByTestId('dict-entry-먹다').first();
    await expect(meokda).toBeVisible({ timeout: 5_000 });
    await expect(results.locator('article').first()).toHaveAttribute(
      'data-testid',
      'dict-entry-먹다',
    );
    await expect(meokda.getByTestId('dict-pos-먹다')).toHaveText('verb');
    await expect(meokda.getByTestId('dict-level-먹다')).toContainText('초급');
    await expect(meokda.getByTestId('dict-pron-먹다')).toHaveText('[먹따]');
    await expect(meokda.getByTestId('dict-senses-먹다')).toContainText('eat');
    // The first sense's Korean definition is the app's own wording; the second sense is KRDict's.
    const sources = meokda.getByTestId('dict-sense-source');
    await expect(sources.first()).toHaveText('App');
    await expect(sources.first()).toHaveAttribute('title', /^Written for this app/);
    await expect(sources.nth(1)).toHaveText('KRDict');
    await expect(meokda.getByTestId('dict-example').first()).toContainText('밥을 먹다.');
    // Korean definition and related-word links; a link looks that word up.
    await expect(meokda.getByTestId('dict-definition-native').first()).toContainText(
      '입에 넣고 씹어서',
    );
    await expect(meokda.getByTestId('dict-relations-synonym').first()).toContainText('드시다');
    // The detail pane (wide layouts) or the inline senses (phones) holds the visible link.
    await page
      .getByRole('button', { name: 'Look up 식사' })
      .filter({ visible: true })
      .first()
      .click();
    await expect(input).toHaveValue('식사');
    await expect(results.getByTestId('dict-entry-식사').first()).toBeVisible({ timeout: 5_000 });

    // Irregular conjugation (ㅂ) also resolves.
    await input.fill('도와요');
    await expect(results.locator('article').first()).toHaveAttribute(
      'data-testid',
      'dict-entry-돕다',
    );

    // 2. 초성 search.
    await input.fill('ㅎㄱ');
    const hanguk = results.getByTestId('dict-entry-한국').first();
    await expect(hanguk).toBeVisible({ timeout: 5_000 });
    await expect(results.getByTestId('dict-entry-학교').first()).toBeVisible();

    // 3. Romanization input, with Hanja origin shown.
    await input.fill('hanguk');
    await expect(results.locator('article').first()).toHaveAttribute(
      'data-testid',
      'dict-entry-한국',
    );
    await expect(results.getByTestId('dict-alt-한국').first()).toHaveText('(韓國)');

    // 4. English → Korean reverse index.
    await input.fill('eat');
    await expect(results.getByTestId('dict-entry-먹다').first()).toBeVisible({ timeout: 5_000 });
    await expect(results.locator('article').first()).toHaveAttribute(
      'data-testid',
      'dict-entry-먹다',
    );

    // Quick Add to Deck maps the Korean entry into a Korean vocabulary card.
    await results.getByTestId('dict-add-btn-먹다').first().click();
    const addBar = results.getByTestId('dict-add-bar-먹다');
    await expect(addBar).toBeVisible();
    await addBar.getByTestId('dict-add-confirm-btn').click();
    await expect(page.getByTestId('dict-added-banner')).toContainText('Added “먹다”');
    await expect(results.getByTestId('dict-in-deck-먹다').first()).toBeVisible();
  });
});
