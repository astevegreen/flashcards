import { expect, test, type Page } from '@playwright/test';

interface SpokenCall {
  text: string;
  lang: string;
}

/**
 * Replaces the browser's speech engine: one on-device Korean voice (a headless browser has none of
 * its own to rely on), and `speak` records what it was asked to say.
 */
async function stubKoreanVoice(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spoken: Array<{ text: string; lang: string }> = [];
    (window as unknown as { __spoken: typeof spoken }).__spoken = spoken;
    // The real utterance only accepts the engine's own voice objects.
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: class {
        lang = '';
        rate = 1;
        voice: unknown = null;
        constructor(readonly text: string) {}
      },
    });
    Object.defineProperty(window.speechSynthesis, 'getVoices', {
      configurable: true,
      value: () => [{ name: 'Test Korean', lang: 'ko-KR', localService: true, default: true }],
    });
    window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
      spoken.push({ text: u.text, lang: u.lang });
    };
  });
}

const spokenCalls = (page: Page): Promise<SpokenCall[]> =>
  page.evaluate(() => (window as unknown as { __spoken: SpokenCall[] }).__spoken);

test('the dictionary speaks a headword from the keyboard, offline', async ({ page, context }) => {
  await stubKoreanVoice(page);
  await page.goto('/?device=dictspeak');
  await expect(page.getByTestId('study-card')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByTestId('pack-install-btn-dict-krdict').click();
  await expect(page.getByTestId('pack-installed-badge-dict-krdict')).toBeVisible({
    timeout: 10_000,
  });

  // Lazily loaded screens come from the service worker once offline.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Words' }).first().click();
  await page.getByTestId('browse-tab-dictionary').click();
  await page.getByTestId('dictionary-search-input').fill('한국');

  const speaker = page
    .getByTestId('dictionary-results')
    .getByRole('button', { name: 'Play pronunciation of 한국', exact: true })
    .first();
  await expect(speaker).toBeVisible({ timeout: 5_000 });

  await speaker.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => spokenCalls(page)).toEqual([{ text: '한국', lang: 'ko-KR' }]);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await spokenCalls(page)).length).toBe(2);
});
