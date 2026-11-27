import { expect, test, type Page } from '@playwright/test';
import { createEventFactory, replayAllEvents } from '../../packages/core/src/events/replay.ts';
import type { FlashEvent } from '../../packages/core/src/events/types.ts';
import { createHlcState } from '../../packages/core/src/hlc.ts';
import {
  deriveCardId,
  deriveNoteId,
  FLASH_NAMESPACE_UUID,
  uuidv5,
} from '../../packages/core/src/ids.ts';
import type { ReviewRating } from '../../packages/core/src/model/types.ts';
import {
  encodeDeviceHead,
  encodeEventsSegment,
  encodeManifest,
} from '../../packages/core/src/sync/codec.ts';

/**
 * Waits until the service worker has precached the app and controls `page`. Going offline before
 * that leaves lazy chunks (the note editor, media players) unloadable: under load the precache can
 * still be running when a test goes offline, and the failed dynamic import blanks the app.
 */
async function waitForOfflineReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

test.describe('Phase 2 Cloud Sync & Web Worker Replay E2E', () => {
  test('2-device live sync (?device=a <-> ?device=b): study, rate, undo, inline edit, and deck settings converge identically', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await pageA.goto('/?device=synca');
    await pageB.goto('/?device=syncb');

    await expect(pageA.getByTestId('study-card')).toBeVisible();
    await expect(pageB.getByTestId('study-card')).toBeVisible();

    const initialNewA = Number(await pageA.getByTestId('count-new').textContent());
    const initialNewB = Number(await pageB.getByTestId('count-new').textContent());
    expect(initialNewA).toBe(initialNewB);
    expect(initialNewA).toBeGreaterThanOrEqual(4);

    // Select Korean Core + Hanja on Device A so we know exact card & note
    await pageA.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });

    const initialKoNew = Number(await pageA.getByTestId('count-new').textContent());
    expect(initialKoNew).toBe(4);

    // 1. Edit first Korean note inline on Device A
    await pageA.keyboard.press('e');
    const dialogA = pageA.locator('dialog[open]');
    await expect(dialogA).toBeVisible();
    await dialogA.locator('textarea').last().fill('Synced across devices!');
    await dialogA.getByRole('button', { name: 'Save' }).click();
    await expect(dialogA).toHaveCount(0);

    // 2. Rate card 1 Easy, then rate card 2 Good, then Undo card 2 -> net 1 reviewed card
    await pageA.keyboard.press('Space');
    await pageA.getByTestId('rate-easy').click();
    await expect(pageA.getByTestId('count-new')).toHaveText(String(initialKoNew - 1));

    await pageA.keyboard.press('Space');
    await pageA.getByTestId('rate-good').click();
    await expect(pageA.getByTestId('count-new')).toHaveText(String(initialKoNew - 2));

    await pageA.keyboard.press('z');
    await expect(pageA.getByTestId('count-new')).toHaveText(String(initialKoNew - 1));

    // 3. Update Korean deck Target retention to 0.85 in Library on Device A
    await pageA.getByRole('button', { name: 'Decks' }).first().click();
    const koRowA = pageA.locator('[data-testid^="deck-row-"]', { hasText: 'Korean Core + Hanja' });
    await koRowA.getByRole('button', { name: 'Options' }).click();
    const retInputA = koRowA.getByLabel('Target retention');
    await retInputA.fill('0.85');
    await retInputA.blur();
    await expect(retInputA).toHaveValue('0.85');

    // 4. Trigger Sync Now on Device A -> pushes segment + head.json -> BroadcastChannel notifies Device B live
    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');
    await expect(pageA.getByTestId('sync-pending-count')).toHaveText('0');

    // 5. Device B should automatically receive the live update via BroadcastChannel (and converge identically)
    await expect(pageB.getByTestId('count-new')).toHaveText(String(initialKoNew - 1));

    // Verify edited note content converged to Device B (Browse search)
    await pageB.getByRole('button', { name: 'Words' }).first().click();
    await pageB.getByLabel('Search notes by text or tag').fill('Synced across devices!');
    await expect(pageB.getByTestId('browse-list')).toContainText('학교');

    // Verify deck Target retention converged on Device B
    await pageB.getByRole('button', { name: 'Decks' }).first().click();
    const koRowB = pageB.locator('[data-testid^="deck-row-"]', { hasText: 'Korean Core + Hanja' });
    await koRowB.getByRole('button', { name: 'Options' }).click();
    await expect(koRowB.getByLabel('Target retention')).toHaveValue('0.85');

    // Both devices hold the same event log, so replay gives them the same card schedules.
    const readEvents = async (p: typeof pageA, dbName: string) =>
      p.evaluate(async (name) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const rows = await new Promise<{ keys: IDBValidKey[]; events: unknown[] }>(
          (resolve, reject) => {
            const tx = db.transaction('events', 'readonly');
            const store = tx.objectStore('events');
            const keysReq = store.getAllKeys();
            const rowsReq = store.getAll();
            tx.oncomplete = () => resolve({ keys: keysReq.result, events: rowsReq.result });
            tx.onerror = () => reject(tx.error);
          },
        );
        db.close();
        // Keys come back in IndexedDB key order, the same on both devices.
        return { ids: rows.keys.map(String), events: rows.events };
      }, dbName);

    /** Each card's derived schedule (due, stability, state) after replaying a device's stored log. */
    const schedulesOf = (events: unknown[]) =>
      [...replayAllEvents(events as FlashEvent[]).cards.values()]
        .map((c) => ({
          id: c.id,
          due: c.schedule.due,
          stability: c.schedule.stability,
          state: c.schedule.state,
        }))
        .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

    // Reload Device B and verify persistence + identical event logs
    await pageB.reload();
    await expect(pageB.getByTestId('study-card')).toBeVisible();
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(pageB.getByTestId('count-new')).toHaveText(String(initialKoNew - 1));

    const logA = await readEvents(pageA, 'flashcards-db-synca');
    const logB = await readEvents(pageB, 'flashcards-db-syncb');
    expect(logB.ids.length).toBeGreaterThan(0);
    expect(logB.ids).toEqual(logA.ids);
    // The state both devices derive from those logs: the schedule of every card matches, and the
    // review made on A has moved a card off its new-card schedule.
    const schedulesA = schedulesOf(logA.events);
    const schedulesB = schedulesOf(logB.events);
    expect(schedulesB.length).toBeGreaterThan(0);
    expect(schedulesB).toEqual(schedulesA);
    expect(schedulesB.some((c) => c.stability > 0)).toBe(true);

    await context.close();
  });

  test('offline queue and reconnect convergence across concurrent edits on two devices', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await pageA.goto('/?device=offa');
    await pageB.goto('/?device=offb');
    await expect(pageA.getByTestId('study-card')).toBeVisible();
    await expect(pageB.getByTestId('study-card')).toBeVisible();

    // Run the initial sync on both
    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');

    await pageB.getByRole('button', { name: 'Settings' }).first().click();
    await pageB.getByTestId('sync-now-btn').click();
    await expect(pageB.getByTestId('sync-status-pill')).toHaveText('Synced');

    // Return both to Study
    await pageA.getByRole('button', { name: 'Study' }).first().click();
    await pageB.getByRole('button', { name: 'Study' }).first().click();

    await pageA
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Essentials (JA)' });
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'Mandarin Basics (ZH)' });

    const initJa = Number(await pageA.getByTestId('count-new').textContent());
    const initZh = Number(await pageB.getByTestId('count-new').textContent());

    // Take both devices offline, once the service worker can serve every chunk
    await waitForOfflineReady(pageA);
    await waitForOfflineReady(pageB);
    await context.setOffline(true);

    // Offline mutation on Device A: rate 1 Japanese card + edit Japanese note
    await pageA.keyboard.press('e');
    const dlgA = pageA.locator('dialog[open]');
    await expect(dlgA).toBeVisible();
    await dlgA.locator('textarea').last().fill('Offline edit from A');
    await dlgA.getByRole('button', { name: 'Save' }).click();
    await expect(dlgA).toHaveCount(0);

    await pageA.keyboard.press('Space');
    await pageA.getByTestId('rate-easy').click();
    await expect(pageA.getByTestId('count-new')).toHaveText(String(initJa - 1));

    // Confirm Settings on Device A shows Offline (queued) with pending events > 0
    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Offline (queued)');
    await expect
      .poll(async () => Number(await pageA.getByTestId('sync-pending-count').textContent()))
      .toBeGreaterThan(0);

    // Concurrent offline mutation on Device B: edit Mandarin note + rate 1 Mandarin card
    await pageB.keyboard.press('e');
    const dlgB = pageB.locator('dialog[open]');
    await expect(dlgB).toBeVisible();
    await dlgB.locator('textarea').last().fill('Offline edit from B');
    await dlgB.getByRole('button', { name: 'Save' }).click();
    await expect(dlgB).toHaveCount(0);

    await pageB.keyboard.press('Space');
    await pageB.getByTestId('rate-easy').click();
    await expect(pageB.getByTestId('count-new')).toHaveText(String(initZh - 1));

    // Reconnect network -> online event triggers automatic sync convergence
    await context.setOffline(false);

    // Ensure both complete sync
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');
    await expect(pageA.getByTestId('sync-pending-count')).toHaveText('0');

    await pageB.getByRole('button', { name: 'Settings' }).first().click();
    await pageB.getByTestId('sync-now-btn').click();
    await expect(pageB.getByTestId('sync-status-pill')).toHaveText('Synced');
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');

    // Verify Device A received Device B's Mandarin edit & review
    await pageA.getByRole('button', { name: 'Words' }).first().click();
    await pageA.getByLabel('Search notes by text or tag').fill('Offline edit from B');
    await expect(pageA.getByTestId('browse-list')).toContainText('学习');

    // Verify Device B received Device A's Japanese edit & review
    await pageB.getByRole('button', { name: 'Words' }).first().click();
    await pageB.getByLabel('Search notes by text or tag').fill('Offline edit from A');
    await expect(pageB.getByTestId('browse-list')).toContainText('日本');

    // Verify Study new counts match on both devices for both decks
    await pageA.getByRole('button', { name: 'Study' }).first().click();
    await pageB.getByRole('button', { name: 'Study' }).first().click();

    await pageA.getByLabel('Select deck to study').selectOption({ label: 'Mandarin Basics (ZH)' });
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'Mandarin Basics (ZH)' });
    await expect(pageA.getByTestId('count-new')).toHaveText(String(initZh - 1));
    await expect(pageB.getByTestId('count-new')).toHaveText(String(initZh - 1));

    await pageA
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Essentials (JA)' });
    await pageB
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Essentials (JA)' });
    await expect(pageA.getByTestId('count-new')).toHaveText(String(initJa - 1));
    await expect(pageB.getByTestId('count-new')).toHaveText(String(initJa - 1));

    await context.close();
  });

  test('Web Worker replays 500 incoming sync events with <= 200 ms main-thread blocking time (§8)', async ({
    page,
  }) => {
    await page.goto('/?device=workerperf');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Open Settings and run initial sync so sync/v1/manifest.json is initialized
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByTestId('sync-now-btn').click();
    await expect(page.getByTestId('sync-status-pill')).toHaveText('Synced');

    // Build 500 real ReviewRecorded events targeting the sample Korean deck's 4 cards
    const koDeckId = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
    const koCardIds = ['ko-1', 'ko-2', 'ko-3', 'ko-4'].map((k) =>
      deriveCardId(deriveNoteId(koDeckId, k), 'layout:vocab-ko:recognition', 0),
    );
    const startMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    const factory = createEventFactory(
      'device-remote500',
      0,
      createHlcState('device-remote500', startMs),
    );
    const remoteEvents: FlashEvent[] = [];
    const ratings: readonly ReviewRating[] = [3, 3, 4, 1, 3];
    for (let i = 0; i < 500; i++) {
      const cardId = koCardIds[i % koCardIds.length] ?? koCardIds[0] ?? '';
      const rating = ratings[i % ratings.length] ?? 3;
      const revTime = startMs + (i + 1) * 3_600_000;
      remoteEvents.push(
        factory.create(
          'ReviewRecorded',
          {
            review_id: `perf-rev-${i + 1}`,
            card_id: cardId,
            rating,
            reviewed_at: revTime,
            tz_offset: 0,
            duration_ms: 900,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: revTime + 86_400_000,
          },
          revTime,
        ),
      );
    }

    const segB64 = bytesToBase64(encodeEventsSegment(remoteEvents));
    const headB64 = bytesToBase64(
      encodeDeviceHead({
        device_id: 'device-remote500',
        last_segment: 1,
        last_seq: 500,
        updated_at: Date.now(),
        segments: [{ seg: 1, from_seq: 1, to_seq: 500, count: 500 }],
      }),
    );

    // Inject remote device's segment + head into dev sync store and start PerformanceObserver on main thread
    await page.evaluate(
      ({ seg, head }) => {
        const prefix = 'flashcards-dev-sync:';
        localStorage.setItem(
          `${prefix}sync/v1/devices/device-remote500/seg-000001.jsonl.gz`,
          JSON.stringify({ b64: seg, updatedAt: Date.now() }),
        );
        localStorage.setItem(
          `${prefix}sync/v1/devices/device-remote500/head.json`,
          JSON.stringify({ b64: head, updatedAt: Date.now() }),
        );

        const win = window as unknown as {
          __longTasks: number[];
          __longTaskObserver?: PerformanceObserver;
        };
        win.__longTasks = [];
        if (typeof PerformanceObserver !== 'undefined') {
          const obs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              win.__longTasks.push(entry.duration);
            }
          });
          try {
            obs.observe({ entryTypes: ['longtask'] });
          } catch {
            // Ignore if longtask unsupported
          }
          win.__longTaskObserver = obs;
        }
      },
      { seg: segB64, head: headB64 },
    );

    // Trigger Sync Now to pull & replay 500 events via Web Worker
    await page.getByTestId('sync-now-btn').click();
    // Wait until all 500 remote events are reflected in "Events stored" (22 Phase 4 seed + 500 = 522)
    await expect(page.getByText('522')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('sync-status-pill')).toHaveText('Synced');

    const totalMainThreadLongTaskMs = await page.evaluate(() => {
      const win = window as unknown as {
        __longTasks?: number[];
        __longTaskObserver?: PerformanceObserver;
      };
      win.__longTaskObserver?.disconnect();
      return (win.__longTasks ?? []).reduce((sum, d) => sum + d, 0);
    });

    // Blueprint §8: Incoming sync of 500 events <= 200 ms main-thread work (replay in Web Worker)
    expect(totalMainThreadLongTaskMs).toBeLessThanOrEqual(200);

    // Verify all 4 Korean cards are no longer New (reps > 0 after 125 reviews each)
    await page.getByRole('button', { name: 'Study' }).first().click();
    await page.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(page.getByTestId('count-new')).toHaveText('0');
  });

  test('production installs generate unique persistent device IDs and regenerate on local reset (§4.2)', async ({
    browser,
  }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto('/');
    await page2.goto('/');

    await page1.getByRole('button', { name: 'Settings' }).first().click();
    await page2.getByRole('button', { name: 'Settings' }).first().click();

    const id1 = (await page1.getByTestId('device-id-value').textContent())?.trim() ?? '';
    const id2 = (await page2.getByTestId('device-id-value').textContent())?.trim() ?? '';

    expect(id1).toMatch(/^web-/);
    expect(id2).toMatch(/^web-/);
    expect(id1).not.toBe('device-local');
    expect(id2).not.toBe('device-local');
    expect(id1).not.toBe(id2);

    // Reloading page1 keeps the same persistent device ID
    await page1.reload();
    await page1.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page1.getByTestId('device-id-value')).toHaveText(id1);

    // Resetting local device data assigns a brand-new unique device ID so it cannot collide with old cloud segments
    // Reset asks for confirmation first (C6).
    page1.once('dialog', (dialog) => void dialog.accept());
    await page1.getByRole('button', { name: 'Reset Local Device Data' }).click();
    await expect(page1.getByTestId('device-id-value')).not.toHaveText(id1);
    const id1AfterReset = (await page1.getByTestId('device-id-value').textContent())?.trim() ?? '';
    expect(id1AfterReset).toMatch(/^web-/);

    await ctx1.close();
    await ctx2.close();
  });

  test('device reset + own-event recovery advances seq cleanly and format_version gate renders read-only banner', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await pageA.goto('/?device=reca');
    await pageB.goto('/?device=recb');
    await expect(pageA.getByTestId('study-card')).toBeVisible();
    await expect(pageB.getByTestId('study-card')).toBeVisible();

    // Select Korean deck and rate 1 card on Device A, then sync
    await pageA.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await pageA.keyboard.press('Space');
    await pageA.getByTestId('rate-easy').click();
    await expect(pageA.getByTestId('count-new')).toHaveText('3');

    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');
    await expect(pageB.getByTestId('count-new')).toHaveText('3');

    // Reset Local Device Data on Device A (same ?device=reca slug), then Sync Now to recover own events
    // Reset asks for confirmation first (C6).
    pageA.once('dialog', (dialog) => void dialog.accept());
    await pageA.getByRole('button', { name: 'Reset Local Device Data' }).click();
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');

    // Rate a SECOND Korean card on Device A after recovery -> seq must NOT collide with recovered seqs!
    await pageA.getByRole('button', { name: 'Study' }).first().click();
    await pageA.getByLabel('Select deck to study').selectOption({ label: 'Korean Core + Hanja' });
    await expect(pageA.getByTestId('count-new')).toHaveText('3');
    await pageA.keyboard.press('Space');
    await pageA.getByTestId('rate-easy').click();
    await expect(pageA.getByTestId('count-new')).toHaveText('2');

    // Push post-recovery review and confirm Device B converges to 2 new cards!
    await pageA.getByRole('button', { name: 'Settings' }).first().click();
    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Synced');
    await expect(pageB.getByTestId('count-new')).toHaveText('2');

    // Inject newer format_version=2 manifest -> Settings must enter read-only upgrade_required mode
    const futureManifestB64 = bytesToBase64(
      encodeManifest({
        collection_id: await pageA.evaluate(() => {
          const raw = localStorage.getItem('flashcards-dev-sync:sync/v1/manifest.json');
          if (!raw) return 'col-fallback';
          const parsed = JSON.parse(raw) as { b64: string };
          const manifest = JSON.parse(atob(parsed.b64)) as { collection_id: string };
          return manifest.collection_id;
        }),
        format_version: 2,
        min_app_version: '0.2.0',
        created_at: Date.now(),
      }),
    );
    await pageA.evaluate((b64) => {
      localStorage.setItem(
        'flashcards-dev-sync:sync/v1/manifest.json',
        JSON.stringify({ b64, updatedAt: Date.now() }),
      );
    }, futureManifestB64);

    await pageA.getByTestId('sync-now-btn').click();
    await expect(pageA.getByTestId('sync-status-pill')).toHaveText('Update required (read-only)');
    await expect(pageA.getByTestId('cloud-sync-card')).toContainText('format v2');

    await context.close();
  });
});
