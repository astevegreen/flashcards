import { expect, test, type Page } from '@playwright/test';

// Minimal valid 44-byte WAV (PCM 8kHz mono) for upload & playback tests
const VALID_WAV_BUFFER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00,
  0x01, 0x00, 0x08, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]);

// Minimal valid MP3 (ID3v2 + MPEG frame sync) returned by mocked Google Cloud TTS
const MOCK_MP3_BASE64 = Buffer.from([
  0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64, 0x00, 0x00,
  0x00, 0x00,
]).toString('base64');

interface RecordedAudioPlay {
  src: string;
  playbackRate: number;
  preservesPitch: boolean;
  muted: boolean;
}

interface RecordedSpeechCall {
  text: string;
  lang: string;
  rate: number;
}

async function installAudioPlaySpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const plays: Array<{
      src: string;
      playbackRate: number;
      preservesPitch: boolean;
      muted: boolean;
    }> = [];
    (window as unknown as { __audioPlays: typeof plays }).__audioPlays = plays;
    HTMLMediaElement.prototype.play = function () {
      plays.push({
        src: this.src,
        playbackRate: this.playbackRate,
        preservesPitch: Boolean(this.preservesPitch),
        muted: Boolean(this.muted),
      });
      return Promise.resolve();
    };
  });
}

async function getUnmutedAudioPlays(page: Page): Promise<RecordedAudioPlay[]> {
  return page.evaluate(() =>
    ((window as unknown as { __audioPlays?: RecordedAudioPlay[] }).__audioPlays ?? []).filter(
      (p) => !p.muted,
    ),
  );
}

test.describe('Phase 5 Audio & TTS Pipeline E2E (§7)', () => {
  test('Attached audio upload, spoof rejection, 1.0x/0.75x playback, and 2-device offline sync', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await installAudioPlaySpy(pageA);
    await installAudioPlaySpy(pageB);

    await pageA.goto('/?device=p5auda');
    await pageB.goto('/?device=p5audb');
    await expect(pageA.getByTestId('study-card')).toBeVisible();
    await expect(pageB.getByTestId('study-card')).toBeVisible();

    // Select Korean deck on Device A and open NoteEditDialog
    await pageA.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await pageA.keyboard.press('e');
    const dialogA = pageA.locator('dialog[open]');
    await expect(dialogA).toBeVisible();

    // 1. Spoofed text-as-MP3 MUST be rejected via magic bytes (§13)
    const [spoofChooser] = await Promise.all([
      pageA.waitForEvent('filechooser'),
      dialogA.getByTestId('upload-audio-audio').click(),
    ]);
    await spoofChooser.setFiles({
      name: 'spoof.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('<html><script>alert(1)</script></html>'),
    });
    await expect(dialogA.getByRole('alert')).toContainText(/valid MP3, WAV, OGG, or M4A/i);
    await expect(dialogA.getByTestId('media-audio-player')).toHaveCount(0);

    // 2. Upload valid WAV clip -> inline MediaAudioPlayer preview appears
    const [wavChooser] = await Promise.all([
      pageA.waitForEvent('filechooser'),
      dialogA.getByTestId('upload-audio-audio').click(),
    ]);
    await wavChooser.setFiles({
      name: 'hello.wav',
      mimeType: 'audio/wav',
      buffer: VALID_WAV_BUFFER,
    });
    await expect(dialogA.getByTestId('media-audio-player')).toBeVisible();
    await dialogA.getByRole('button', { name: 'Save' }).click();
    await expect(dialogA).toHaveCount(0);

    // 3. Play at 1.0x ('R') and 0.75x ('S') on Device A -> asserts blob: URL, playbackRate, preservesPitch
    await pageA.keyboard.press('r');
    await expect
      .poll(async () => (await getUnmutedAudioPlays(pageA)).length)
      .toBeGreaterThanOrEqual(1);
    await pageA.keyboard.press('s');
    await expect
      .poll(async () => (await getUnmutedAudioPlays(pageA)).length)
      .toBeGreaterThanOrEqual(2);

    const playsA = await getUnmutedAudioPlays(pageA);
    expect(playsA.some((p) => p.src.startsWith('blob:') && p.playbackRate === 1)).toBe(true);
    expect(
      playsA.some(
        (p) => p.src.startsWith('blob:') && p.playbackRate === 0.75 && p.preservesPitch === true,
      ),
    ).toBe(true);

    // 4. Sync Device A -> Device B, go offline on Device B, play attached audio offline!
    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');

    await pageB.getByRole('button', { name: 'Settings' }).first().click();
    await pageB.getByTestId('sync-now-btn').click();
    await expect(pageB.getByTestId('sync-status-pill')).toHaveText('Synced');

    await context.setOffline(true);
    await pageB.getByRole('button', { name: 'Study' }).first().click();
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await pageB.keyboard.press('s');

    await expect
      .poll(async () => (await getUnmutedAudioPlays(pageB)).length)
      .toBeGreaterThanOrEqual(1);
    const playsB = await getUnmutedAudioPlays(pageB);
    expect(
      playsB.some(
        (p) => p.src.startsWith('blob:') && p.playbackRate === 0.75 && p.preservesPitch === true,
      ),
    ).toBe(true);

    await context.setOffline(false);
    await context.close();
  });

  test('BYO Google Cloud TTS caches at 1.0x, replays with 0 network calls, and syncs to key-less offline Device B', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    let apiCalls = 0;

    await context.route(
      'https://texttospeech.googleapis.com/v1/text:synthesize*',
      async (route) => {
        apiCalls += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ audioContent: MOCK_MP3_BASE64 }),
        });
      },
    );

    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await installAudioPlaySpy(pageA);
    await installAudioPlaySpy(pageB);

    await pageA.goto('/?device=p5ttsa');
    await pageB.goto('/?device=p5ttsb');
    await expect(pageA.getByTestId('study-card')).toBeVisible();
    await expect(pageB.getByTestId('study-card')).toBeVisible();

    // Configure BYO Google Cloud TTS API key on Device A only (never synced to Device B)
    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await pageA.getByTestId('tts-provider-select').selectOption('google');
    await pageA.getByTestId('tts-api-key-input').fill('AIzaFakeByoKeyForTest');
    await pageA.getByTestId('tts-save-btn').click();

    // Study Korean deck on Device A -> press R (triggers 1 Google Cloud TTS call + caches MP3)
    await pageA.getByRole('button', { name: 'Study' }).first().click();
    await pageA.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await pageA.keyboard.press('r');
    await expect.poll(() => apiCalls).toBe(1);
    await expect
      .poll(async () => (await getUnmutedAudioPlays(pageA)).length)
      .toBeGreaterThanOrEqual(1);

    // Press R and S again -> MUST hit local cache with ZERO additional network calls!
    await pageA.keyboard.press('r');
    await pageA.keyboard.press('s');
    await expect
      .poll(async () => (await getUnmutedAudioPlays(pageA)).length)
      .toBeGreaterThanOrEqual(3);
    expect(apiCalls).toBe(1);

    const playsA = await getUnmutedAudioPlays(pageA);
    expect(
      playsA.some(
        (p) => p.src.startsWith('blob:') && p.playbackRate === 0.75 && p.preservesPitch === true,
      ),
    ).toBe(true);

    // Sync Device A -> Device B (Device B has NO API key configured)
    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await expect(pageA.getByTestId('audio-clip-count')).toHaveText('1');
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');

    await pageB.getByRole('button', { name: 'Settings' }).first().click();
    await pageB.getByTestId('sync-now-btn').click();
    await expect(pageB.getByTestId('sync-status-pill')).toHaveText('Synced');
    await expect(pageB.getByTestId('audio-clip-count')).toHaveText('1');
    // Confirm API key was NOT synced to Device B
    await expect(pageB.getByTestId('tts-provider-select')).toHaveValue('none');

    // Go offline on key-less Device B -> plays synced neural MP3 with 0 network calls!
    await context.setOffline(true);
    await pageB.getByRole('button', { name: 'Study' }).first().click();
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await pageB.keyboard.press('r');

    await expect
      .poll(async () => (await getUnmutedAudioPlays(pageB)).length)
      .toBeGreaterThanOrEqual(1);
    expect(apiCalls).toBe(1);

    await context.setOffline(false);
    await context.close();
  });

  test('Offline Device TTS enforces localService === true and shows one-time dismissible voice-pack banner', async ({
    context,
    page,
  }) => {
    await page.addInitScript(() => {
      const spoken: Array<{ text: string; lang: string; rate: number }> = [];
      (window as unknown as { __spokenCalls: typeof spoken }).__spokenCalls = spoken;
      Object.defineProperty(window.speechSynthesis, 'getVoices', {
        configurable: true,
        value: () => [
          {
            name: 'Google Remote Korean',
            lang: 'ko-KR',
            localService: false,
            default: true,
            voiceURI: 'remote-ko',
          },
        ],
      });
      window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
        spoken.push({ text: u.text, lang: u.lang, rate: u.rate });
      };
    });

    await page.goto('/?device=p5offlinevoice');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });

    // Go offline -> remote voice MUST NOT be used; one-time banner MUST appear
    await context.setOffline(true);
    await page.keyboard.press('r');

    const banner = page.getByTestId('missing-voice-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/offline Korean voice/i);

    const spokenCount = await page.evaluate(
      () =>
        ((window as unknown as { __spokenCalls?: RecordedSpeechCall[] }).__spokenCalls ?? [])
          .length,
    );
    expect(spokenCount).toBe(0);

    // Dismiss banner -> persisted in KV so it does not reappear on reload for the same language
    await page.getByTestId('dismiss-missing-voice-btn').click();
    await expect(banner).toHaveCount(0);

    await context.setOffline(false);
    await page.reload();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });

    await context.setOffline(true);
    await page.keyboard.press('r');
    await page.waitForTimeout(200);
    await expect(page.getByTestId('missing-voice-banner')).toHaveCount(0);
    await context.setOffline(false);
  });

  test('speech_override disambiguates spoken text and ::say[...] in PageViewer uses unified audio pipeline', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const spoken: Array<{ text: string; lang: string; rate: number }> = [];
      (window as unknown as { __spokenCalls: typeof spoken }).__spokenCalls = spoken;
      window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
        spoken.push({ text: u.text, lang: u.lang, rate: u.rate });
      };
    });

    await page.goto('/?device=p5override');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Essentials (JA)' });

    // Set per-note speech_override in NoteEditDialog
    await page.keyboard.press('e');
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('speech-override-input').fill('はしのおと');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    // Press R -> must speak the speech_override text in ja-JP
    await page.keyboard.press('r');
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            (window as unknown as { __spokenCalls?: RecordedSpeechCall[] }).__spokenCalls ?? []
          ).some((c) => c.text === 'はしのおと' && c.lang === 'ja-JP' && c.rate === 1),
        ),
      )
      .toBe(true);

    // Open sample Lesson Page in Library and click ::say[...] normally & with Shift for 0.75x
    await page.getByRole('button', { name: 'Library' }).first().click();
    const coursesPanel = page.getByTestId('courses-panel');
    await expect(coursesPanel).toBeVisible();
    await coursesPanel.getByTestId('course-open-page-0').click();
    const viewer = page.getByTestId('page-viewer');
    await expect(viewer).toBeVisible();

    const sayBtn = viewer.getByTestId('directive-say').first();
    await expect(sayBtn).toBeVisible();
    await sayBtn.click();
    await sayBtn.click({ modifiers: ['Shift'] });

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const calls =
            (window as unknown as { __spokenCalls?: RecordedSpeechCall[] }).__spokenCalls ?? [];
          return calls.some((c) => c.rate === 0.75 && c.lang === 'ja-JP');
        }),
      )
      .toBe(true);
  });

  test('SpeakerButton does not flip card, and auto_play_audio respects speak_on reveal for Production layout', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const spoken: Array<{ text: string; lang: string; rate: number }> = [];
      (window as unknown as { __spokenCalls: typeof spoken }).__spokenCalls = spoken;
      window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
        spoken.push({ text: u.text, lang: u.lang, rate: u.rate });
      };
    });

    await page.goto('/?device=p5autoplay');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });

    // Clicking on-card SpeakerButton (1.0x and 0.75x) plays audio without flipping the card
    await page.getByTestId('study-audio-play').click();
    await page.getByTestId('study-audio-slow').click();
    await expect(page.getByTestId('card-back')).toHaveCount(0);

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const calls =
            (window as unknown as { __spokenCalls?: RecordedSpeechCall[] }).__spokenCalls ?? [];
          return calls.some((c) => c.rate === 1) && calls.some((c) => c.rate === 0.75);
        }),
      )
      .toBe(true);

    // Enable Auto-play audio in Settings
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByTestId('auto-play-audio-toggle').check();

    // Switch Korean Core + Hanja to Production layout only (speak_on: 'reveal')
    await page.getByRole('button', { name: 'Library' }).first().click();
    const koRow = page.locator('[data-testid^="deck-row-"]', { hasText: 'Korean Core + Hanja' });
    await koRow.getByRole('button', { name: 'Production' }).click();
    await koRow.getByRole('button', { name: 'Recognition' }).click();

    // Clear recorded speech calls, then open Study -> front must NOT auto-speak!
    await page.evaluate(() => {
      const calls = (window as unknown as { __spokenCalls?: unknown[] }).__spokenCalls;
      if (calls) calls.length = 0;
    });
    await koRow.getByRole('button', { name: 'Study' }).click();
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.waitForTimeout(150);
    const beforeFlip = await page.evaluate(
      () => ((window as unknown as { __spokenCalls?: unknown[] }).__spokenCalls ?? []).length,
    );
    expect(beforeFlip).toBe(0);

    // Flip card (0 -> 1) -> MUST auto-speak on reveal!
    await page.getByTestId('reveal-button').click();
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(
          () => ((window as unknown as { __spokenCalls?: unknown[] }).__spokenCalls ?? []).length,
        ),
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('Settings Test Voice uses unsaved draft API key, SpeakerButton long-press plays 0.75x once without flipping, and Reset Local Data clears in-memory TTS config', async ({
    page,
  }) => {
    let apiCalls = 0;
    await page.route('https://texttospeech.googleapis.com/v1/text:synthesize*', async (route) => {
      apiCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ audioContent: MOCK_MP3_BASE64 }),
      });
    });

    await installAudioPlaySpy(page);
    await page.addInitScript(() => {
      const spoken: Array<{ text: string; lang: string; rate: number }> = [];
      (window as unknown as { __spokenCalls: typeof spoken }).__spokenCalls = spoken;
      window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
        spoken.push({ text: u.text, lang: u.lang, rate: u.rate });
      };
    });

    await page.goto('/?device=p5draft');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });

    // 1. Timed long-press (>= 450ms) on SpeakerButton -> triggers 0.75x ONCE and does NOT flip card
    const playBtn = page.getByTestId('study-audio-play');
    const box = await playBtn.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(520);
      await page.mouse.up();
    }
    await expect(page.getByTestId('card-back')).toHaveCount(0);
    const longPressCalls = await page.evaluate(
      () => (window as unknown as { __spokenCalls?: RecordedSpeechCall[] }).__spokenCalls ?? [],
    );
    expect(longPressCalls.length).toBe(1);
    expect(longPressCalls[0]?.rate).toBe(0.75);

    // 2. Settings Test Voice tests unsaved draft API key BEFORE clicking Save
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByTestId('tts-provider-select').selectOption('google');
    await page.getByTestId('tts-api-key-input').fill('AIzaUnsavedDraftKey');
    await page.getByTestId('tts-test-btn').click();
    await expect(page.getByTestId('tts-test-status')).toContainText(/Cloud TTS/i);
    expect(apiCalls).toBe(1);

    // 3. Save settings, then Reset Local Device Data -> in-memory TTS config clears immediately without reload
    await page.getByTestId('tts-save-btn').click();
    await expect(page.getByTestId('tts-provider-select')).toHaveValue('google');
    await page.getByRole('button', { name: 'Reset Local Device Data' }).click();
    await expect(page.getByTestId('tts-provider-select')).toHaveValue('none');
  });

  test('Custom layout created in Library excludes audio field from reveal_steps (no duplicate MediaAudioPlayer on card back)', async ({
    page,
  }) => {
    await installAudioPlaySpy(page);
    await page.goto('/?device=p5customlayout');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });

    // Attach valid WAV audio to the first card's note
    await page.keyboard.press('e');
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    const [wavChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      dialog.getByTestId('upload-audio-audio').click(),
    ]);
    await wavChooser.setFiles({
      name: 'clip.wav',
      mimeType: 'audio/wav',
      buffer: VALID_WAV_BUFFER,
    });
    await expect(dialog.getByTestId('media-audio-player')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    // Create a custom Flip layout in Library -> Options
    await page.getByRole('button', { name: 'Library' }).first().click();
    const koRow = page.locator('[data-testid^="deck-row-"]', { hasText: 'Korean Core + Hanja' });
    await koRow.getByRole('button', { name: 'Options' }).click();
    await koRow.getByLabel('Answer mode').selectOption('flip');
    await koRow.getByLabel('Layout label').fill('CustomAudioCheck');
    await koRow.locator('[data-testid^="add-layout-submit-"]').click();

    // Switch exclusively to the new custom layout and study
    await koRow.getByRole('button', { name: 'Recognition' }).click();
    await koRow.getByRole('button', { name: 'CustomAudioCheck' }).click();
    await koRow.getByRole('button', { name: 'Study' }).click();
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Reveal step 1 and step 2 (where remainingFields used to include 'audio')
    await page.getByTestId('reveal-button').click();
    await expect(page.getByTestId('card-back')).toBeVisible();
    const revealMoreBtn = page.getByRole('button', { name: /Reveal more/i });
    await expect(revealMoreBtn).toBeVisible();
    await revealMoreBtn.click();
    await expect(revealMoreBtn).toHaveCount(0);

    // Card back must NOT duplicate an inline MediaAudioPlayer from reveal_steps
    await expect(page.getByTestId('study-card').getByTestId('media-audio-player')).toHaveCount(0);

    // On-card SpeakerButton still plays the attached audio clip
    await page.getByTestId('study-audio-play').click();
    await expect
      .poll(async () => (await getUnmutedAudioPlays(page)).length)
      .toBeGreaterThanOrEqual(1);
  });

  test('StudyScreen does not prematurely stop Cloud TTS playback or Device TTS fallback when AppProvider re-renders', async ({
    page,
  }) => {
    let shouldFail = false;
    await page.route('https://texttospeech.googleapis.com/v1/text:synthesize*', async (route) => {
      if (shouldFail) {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'API key invalid' } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ audioContent: MOCK_MP3_BASE64 }),
      });
    });

    await page.addInitScript(() => {
      const audioEvents: Array<{ type: 'play' | 'pause'; src: string; muted: boolean }> = [];
      const speechEvents: Array<'speak' | 'cancel'> = [];
      (window as unknown as { __audioEvents: typeof audioEvents }).__audioEvents = audioEvents;
      (window as unknown as { __speechEvents: typeof speechEvents }).__speechEvents = speechEvents;

      HTMLMediaElement.prototype.play = function () {
        audioEvents.push({ type: 'play', src: this.src, muted: Boolean(this.muted) });
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function () {
        audioEvents.push({ type: 'pause', src: this.src, muted: Boolean(this.muted) });
      };
      window.speechSynthesis.speak = () => {
        speechEvents.push('speak');
      };
      window.speechSynthesis.cancel = () => {
        speechEvents.push('cancel');
      };
    });

    await page.goto('/?device=p5nostop');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Configure BYO Google Cloud TTS
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByTestId('tts-provider-select').selectOption('google');
    await page.getByTestId('tts-api-key-input').fill('AIzaNoStopKey');
    await page.getByTestId('tts-save-btn').click();

    // Return to Study -> Korean deck -> press R (synthesizes Cloud TTS & emits MediaAdded)
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await page.evaluate(() => {
      (window as unknown as { __audioEvents: unknown[] }).__audioEvents.length = 0;
    });
    await page.keyboard.press('r');

    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as {
              __audioEvents: Array<{ type: string; src: string; muted: boolean }>;
            }
          ).__audioEvents.some((e) => e.type === 'play' && !e.muted && e.src.startsWith('blob:')),
        ),
      )
      .toBe(true);

    // Give React time to commit MediaAdded / stateVersion updates; playback MUST NOT be paused!
    await page.waitForTimeout(150);
    const lastAudioEvent = await page.evaluate(() => {
      const evs = (
        window as unknown as {
          __audioEvents: Array<{ type: string; src: string; muted: boolean }>;
        }
      ).__audioEvents.filter((e) => !e.muted && e.src.startsWith('blob:'));
      return evs[evs.length - 1]?.type ?? null;
    });
    expect(lastAudioEvent).toBe('play');

    // Now simulate Cloud TTS 403 error on a different deck (Japanese) -> falls back to Device TTS
    shouldFail = true;
    await page
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Essentials (JA)' });
    await page.evaluate(() => {
      (window as unknown as { __speechEvents: unknown[] }).__speechEvents.length = 0;
    });
    await page.keyboard.press('r');

    // Warning banner appears (triggers AppProvider re-render)
    await expect(page.getByTestId('audio-warning-banner')).toBeVisible();
    await page.waitForTimeout(150);

    // Fallback speechSynthesis utterance MUST NOT be cancelled by the warning banner re-render!
    const lastSpeechEvent = await page.evaluate(() => {
      const evs = (window as unknown as { __speechEvents: string[] }).__speechEvents;
      return evs[evs.length - 1] ?? null;
    });
    expect(lastSpeechEvent).toBe('speak');
  });
});
