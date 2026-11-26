import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { PRODUCTION_CSP } from '../../apps/web/csp.ts';
import { readStoredCards } from './helpers/stored-cards.ts';

const DECK_NAME = 'Korean Core + Hanja';

const dbNameFor = (page: Page) => `flashcards-db-${new URL(page.url()).searchParams.get('device')}`;

/** Reads all rows of an IndexedDB object store in the page. */
async function readStore<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(
    async ({ dbName, storeName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    { dbName: dbNameFor(page), storeName: store },
  ) as Promise<T[]>;
}

interface EventRow {
  type: string;
  payload: Record<string, unknown>;
}

const PASTED_NOTES = 60;

/**
 * Appends a deterministic simulated review history for every card of the Korean deck straight
 * into the app's event log (as if synced from another device): a learner whose memory is a bit
 * weaker than the default weights assume, reviewed on later study days. Returns the number of
 * eligible reviews written.
 */
async function seedReviewHistory(page: Page, deckId: string): Promise<number> {
  const cards = (await readStoredCards(page, dbNameFor(page)))
    .filter((c) => c.deck_id === deckId)
    .map((c) => c.id);
  return page.evaluate(
    async ({ dbName, cards }) => {
      const DAY = 86_400_000;
      const REVIEWS_PER_CARD = 9;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const getAll = (store: string) =>
        new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(store, 'readonly').objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const kv = (await getAll('kv')) as { key: string; value: unknown }[];
      const counterRow = kv.find((r) => r.key === '__local_seq_counter');
      let localSeq = typeof counterRow?.value === 'number' ? counterRow.value : 0;

      let x = 20_261_122;
      const rand = () => {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        return x / 2 ** 32;
      };
      // One simulated review after the first: recall on a 0.9-at-stability curve, then grow
      // or shrink the learner's stability and the next interval. rand() order is fixed.
      const simulateReview = (interval: number, trueStability: number) => {
        if (rand() >= 0.9 ** (interval / trueStability)) {
          return { rating: 1, trueStability: Math.max(0.5, trueStability * 0.4), interval: 1 };
        }
        const rating = rand() < 0.1 ? 4 : 3;
        return {
          rating,
          trueStability: trueStability * 2.2,
          interval: Math.min(55, Math.round(interval * 2.5)),
        };
      };
      const start = Date.now() - 520 * DAY;
      const device = 'seed-history';
      const rows: unknown[] = [];
      let seq = 0;
      let eligible = 0;
      cards.forEach((cardId, c) => {
        let at = start + (c % 12) * 3_600_000;
        let interval = 2;
        let trueStability = 1.5;
        for (let i = 0; i < REVIEWS_PER_CARD; i++) {
          let rating = 3;
          if (i > 0) {
            const step = simulateReview(interval, trueStability);
            rating = step.rating;
            trueStability = step.trueStability;
            interval = step.interval;
            eligible += 1;
          }
          seq += 1;
          localSeq += 1;
          const hlcCounter = (seq & 0xffff).toString(16).padStart(4, '0');
          rows.push({
            id: `seed-review-${seq}`,
            device,
            seq,
            hlc: `${at.toString(16).padStart(12, '0')}-${hlcCounter}-${device}`,
            type: 'ReviewRecorded',
            v: 1,
            card_id: cardId,
            local_seq: localSeq,
            payload: {
              review_id: `seed-review-${seq}`,
              card_id: cardId,
              rating,
              reviewed_at: at,
              tz_offset: 0,
              duration_ms: 2000,
              answer_mode: 'flip',
              fsrs_params_version: 0,
              resulting_due_at: at + interval * DAY,
            },
          });
          at += interval * DAY;
        }
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['events', 'kv'], 'readwrite');
        const events = tx.objectStore('events');
        for (const row of rows) events.put(row);
        tx.objectStore('kv').put({ key: '__local_seq_counter', value: localSeq });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return eligible;
    },
    { dbName: dbNameFor(page), cards },
  );
}

/**
 * Pastes {@link PASTED_NOTES} notes into the Korean deck (the optimizer needs many cards, not
 * just many reviews), waits for them to persist, seeds the review history and reloads the app.
 */
async function seedAndReload(page: Page): Promise<{ deckId: string; eligible: number }> {
  await page.getByRole('button', { name: 'Decks' }).first().click();
  await page.getByTestId('import-export-btn').click();
  const rows = Array.from({ length: PASTED_NOTES }, (_, i) => `단어${i},meaning ${i},optimizer`);
  await page.getByTestId('bring-link-input').fill(['Word,Meaning,Tags', ...rows].join('\n'));
  await page.getByTestId('bring-link-submit').click();
  await page.getByTestId('bring-csv-target').selectOption({ label: DECK_NAME });
  await page.getByTestId('bring-csv-import-btn').click();
  await expect(page.getByTestId('bring-csv-status')).toContainText(
    `Imported ${PASTED_NOTES} note(s)`,
  );

  let deckId = '';
  await expect
    .poll(async () => {
      const events = await readStore<EventRow>(page, 'events');
      deckId = String(
        events.find((e) => e.type === 'DeckCreated' && e.payload['name'] === DECK_NAME)?.payload[
          'deck_id'
        ] ?? '',
      );
      const cards = await readStoredCards(page, dbNameFor(page));
      return cards.filter((c) => deckId !== '' && c.deck_id === deckId).length;
    })
    .toBeGreaterThanOrEqual(PASTED_NOTES);
  const eligible = await seedReviewHistory(page, deckId);
  expect(eligible).toBeGreaterThanOrEqual(400);
  await page.reload();
  await expect(page.getByTestId('study-card')).toBeVisible();
  return { deckId, eligible };
}

async function readParamsEvents(page: Page, deckId: string) {
  const events = await readStore<EventRow>(page, 'events');
  return events
    .filter((e) => e.type === 'DeckFSRSParamsChanged' && e.payload['deck_id'] === deckId)
    .map((e) => ({
      version: e.payload['params_version'],
      reschedule: e.payload['reschedule_existing'] ?? false,
      w: (e.payload['params'] as { w?: number[] } | undefined)?.w?.length,
    }));
}

async function readWeights(page: Page, deckId: string) {
  const events = await readStore<EventRow>(page, 'events');
  return events
    .filter((e) => e.type === 'DeckFSRSParamsChanged' && e.payload['deck_id'] === deckId)
    .map((e) => (e.payload['params'] as { w?: number[] } | undefined)?.w);
}

async function openDeckOptions(page: Page) {
  await page.getByRole('button', { name: 'Decks' }).first().click();
  const row = page.locator('[data-testid^="deck-row-"]', { hasText: DECK_NAME });
  await row.getByRole('button', { name: 'Options' }).click();
  const panel = row.getByRole('region', { name: 'FSRS optimizer' });
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('Phase 11 on-device FSRS optimizer', () => {
  // The cancel step holds the optimizer's `.wasm` download, so requests must reach the network
  // layer rather than the service worker's precache.
  test.use({ serviceWorkers: 'block' });

  test('explains the minimum, then optimizes with progress, cancel and a before/after estimate', async ({
    page,
    context,
  }) => {
    await page.goto('/?device=fsrsopt');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // A fresh sample deck has no history: the optimizer explains why it cannot run yet.
    let panel = await openDeckOptions(page);
    await expect(panel.getByTestId('fsrs-optimizer-count')).toHaveText('0');
    await expect(panel.getByTestId('fsrs-optimizer-why')).toContainText(
      'Needs at least 400 eligible reviews (400 more)',
    );
    const optimize = panel.getByRole('button', { name: 'Optimize weights' });
    await expect(optimize).toBeDisabled();
    await expect(optimize).toHaveAccessibleDescription(/Needs at least 400 eligible reviews/);

    const { deckId, eligible } = await seedAndReload(page);

    panel = await openDeckOptions(page);
    await expect(panel.getByTestId('fsrs-optimizer-count')).toHaveText(String(eligible));
    await expect(panel.getByTestId('fsrs-optimizer-why')).toHaveCount(0);

    // Hold the WASM download so the run is deterministically in progress when we cancel.
    const held: Route[] = [];
    await context.route('**/*.wasm', (route) => {
      held.push(route);
    });
    await panel.getByRole('button', { name: 'Optimize weights' }).click();
    await expect(panel.getByRole('progressbar', { name: 'Optimizer progress' })).toBeVisible();
    await expect(panel.getByText('Step 2 of 3: Loading the optimizer…')).toBeVisible();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel.getByText('Optimization cancelled.')).toBeVisible();
    await expect(panel.getByRole('progressbar')).toHaveCount(0);
    for (const route of held) await route.abort().catch(() => {});
    await context.unroute('**/*.wasm');

    // Run to completion: the before/after retention estimate appears; nothing is saved yet.
    await panel.getByRole('button', { name: 'Optimize weights' }).click();
    const result = panel.getByTestId('fsrs-optimizer-result');
    await expect(result).toBeVisible({ timeout: 30_000 });
    const estimate = result.getByTestId('fsrs-optimizer-estimate');
    await expect(estimate.getByRole('row', { name: /^Current/ })).toContainText('%');
    await expect(estimate.getByRole('row', { name: /^Optimized/ })).toContainText('%');
    await expect(result.getByTestId('fsrs-optimizer-measured')).toHaveText(/^\d+\.\d%$/);
    await expect(result).toContainText('The optimized weights fit your review history better.');
    expect(await readParamsEvents(page, deckId)).toEqual([]);

    // Apply with "Reschedule existing cards" -> one DeckFSRSParamsChanged event with 21 weights.
    await result.getByLabel('Reschedule existing cards with the new weights').check();
    await result.getByRole('button', { name: 'Apply weights' }).click();
    await expect(panel.getByRole('status')).toContainText(
      'Saved optimized weights as FSRS parameters v1. Existing cards were rescheduled.',
    );
    await expect
      .poll(() => readParamsEvents(page, deckId))
      .toEqual([{ version: 1, reschedule: true, w: 21 }]);
  });
});

test.describe('Phase 11 FSRS optimizer licence notice', () => {
  test('Settings reproduces the fsrs-browser BSD-3-Clause notice', async ({ page }) => {
    await page.goto('/?device=fsrslic');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).first().click();
    const notice = page.getByTestId('third-party-notice-fsrs-browser');
    await expect(notice).toContainText('BSD-3-Clause');
    await notice.locator('summary').click();
    await expect(notice).toContainText('Copyright 2023 Alex Nguyen');
    await expect(notice).toContainText('Redistributions in binary form must reproduce');
    const shipped = await page.request.get('/THIRD-PARTY-NOTICES.txt');
    expect(shipped.ok()).toBe(true);
    expect(await shipped.text()).toContain('Copyright 2023 Alex Nguyen');
  });
});

test.describe('Phase 11 FSRS optimizer offline', () => {
  test('the precached WASM optimizer runs offline and applies weights for future reviews', async ({
    page,
    context,
  }) => {
    await page.goto('/?device=fsrsoff');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready;
      }
    });
    const { deckId, eligible } = await seedAndReload(page);

    await context.setOffline(true);
    const panel = await openDeckOptions(page);
    await expect(panel.getByTestId('fsrs-optimizer-count')).toHaveText(String(eligible));
    await panel.getByRole('button', { name: 'Optimize weights' }).click();
    const result = panel.getByTestId('fsrs-optimizer-result');
    await expect(result).toBeVisible({ timeout: 30_000 });
    await result.getByRole('button', { name: 'Apply weights' }).click();
    await expect(panel.getByRole('status')).toContainText(
      'They apply to future reviews; existing due dates are unchanged.',
    );
    await expect
      .poll(() => readParamsEvents(page, deckId))
      .toEqual([{ version: 1, reschedule: false, w: 21 }]);

    // A later target-retention edit writes v2 and keeps the optimized weights.
    const row = page.locator('[data-testid^="deck-row-"]', { hasText: DECK_NAME });
    const retention = row.getByLabel('Target retention');
    await retention.fill('0.85');
    await retention.blur();
    await expect
      .poll(() => readParamsEvents(page, deckId))
      .toEqual([
        { version: 1, reschedule: false, w: 21 },
        { version: 2, reschedule: false, w: 21 },
      ]);
    const [v1, v2] = await readWeights(page, deckId);
    expect(v2).toEqual(v1);
  });
});

/**
 * CSP regression guard for WASM in Workers. `vite preview` sends no CSP header, so the page only
 * has the production meta-tag CSP, which a dedicated Worker does not inherit. Here every response
 * carries the CSP header documented for production hosting (docs/setup-gcp-cloudflare.md §6),
 * so the optimizer Worker runs under exactly the policy a real host gives it.
 */
async function serveWithCspHeader(
  context: BrowserContext,
  policyFor: (url: URL) => string,
): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      // Never reach the real network from these specs.
      await route.abort('blockedbyclient');
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': policyFor(url) },
    });
  });
}

const WORKER_SCRIPT = /\/assets\/fsrs-optimizer\.worker-[\w-]+\.js$/;

test.describe('Phase 11 FSRS optimizer under the production CSP header', () => {
  test.use({ serviceWorkers: 'block' });

  test('the documented hosting CSP lets the optimizer Worker compile its WASM', async ({
    page,
    context,
  }) => {
    await serveWithCspHeader(context, () => PRODUCTION_CSP);
    await page.goto('/?device=fsrscsp');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await seedAndReload(page);
    const panel = await openDeckOptions(page);
    await panel.getByRole('button', { name: 'Optimize weights' }).click();
    await expect(panel.getByTestId('fsrs-optimizer-result')).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole('alert')).toHaveCount(0);
  });

  test('without wasm-unsafe-eval on the Worker response the run fails (the guard works)', async ({
    page,
    context,
  }) => {
    const noWasm = PRODUCTION_CSP.replace(" 'wasm-unsafe-eval'", '');
    expect(noWasm).not.toContain('wasm-unsafe-eval');
    await serveWithCspHeader(context, (url) =>
      WORKER_SCRIPT.test(url.pathname) ? noWasm : PRODUCTION_CSP,
    );
    await page.goto('/?device=fsrscspneg');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await seedAndReload(page);
    const panel = await openDeckOptions(page);
    await panel.getByRole('button', { name: 'Optimize weights' }).click();
    await expect(panel.getByRole('alert')).toContainText('Optimization failed', {
      timeout: 30_000,
    });
    await expect(panel.getByTestId('fsrs-optimizer-result')).toHaveCount(0);
  });
});
