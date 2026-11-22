import { expect, test, type Page } from '@playwright/test';
import {
  createEventFactory,
  replayAllEvents,
  type CollectionState,
} from '../../packages/core/src/events/replay.ts';
import type { FlashEvent } from '../../packages/core/src/events/types.ts';
import { createHlcState } from '../../packages/core/src/hlc.ts';
import {
  deriveCardId,
  deriveNoteId,
  FLASH_NAMESPACE_UUID,
  uuidv5,
} from '../../packages/core/src/ids.ts';
import type { ReviewRating } from '../../packages/core/src/model/types.ts';
import { buildSampleDeckEvents } from '../../packages/core/src/samples/decks.ts';
import { encodeDeviceHead, encodeEventsSegment } from '../../packages/core/src/sync/codec.ts';

/** Counts persisted events of one type in the device's IndexedDB event log. */
async function countStoredEvents(page: Page, dbName: string, type: string): Promise<number> {
  return page.evaluate(
    async ([name, eventType]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise<number>((resolve, reject) => {
          const req = db
            .transaction('events', 'readonly')
            .objectStore('events')
            .index('type')
            .count(eventType);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    [dbName, type] as const,
  );
}

async function openStudy(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Study' }).first().click();
  await expect(page.getByLabel('Select deck to study')).toBeVisible();
}

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId('study-filter-btn').click();
  await expect(page.getByTestId('study-filter-panel')).toBeVisible();
}

async function syncNow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByTestId('sync-now-btn').click();
  await expect(page.getByTestId('sync-status-pill')).toHaveText('Synced');
  await expect(page.getByTestId('sync-pending-count')).toHaveText('0');
}

const KOREAN = 'Korean Core + Hanja';

test.describe('Phase 9 Study Sets, custom study and leech auto-suspend', () => {
  test('Study Sets: save a filter, study it on schedule and as practice, rename and delete across ?device=a / ?device=b', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto('/?device=p9setsa');
    await pageB.goto('/?device=p9setsb');
    await expect(pageA.getByTestId('study-card')).toBeVisible();
    await expect(pageB.getByTestId('study-card')).toBeVisible();
    await pageA.getByLabel('Select deck to study').selectOption({ label: KOREAN });
    await expect(pageA.getByTestId('count-new')).toHaveText('4');

    // Device A: pick the #hanja category and save "Study this filter" as a set.
    await openPanel(pageA);
    await expect(pageA.getByTestId('study-sets-empty')).toBeVisible();
    await pageA.getByTestId('study-filter-category-toggle').click();
    await pageA.getByTestId('study-filter-category-option-hanja').locator('xpath=..').click();
    await expect(pageA.getByTestId('study-filter-count-custom')).toHaveText('3 due · 3 cards');
    await pageA.getByTestId('study-filter-save-custom').click();
    await pageA.getByTestId('study-set-name-input').fill('Hanja words');
    await pageA.getByTestId('study-set-save-confirm').click();
    const rowA = pageA.getByTestId('study-set-row');
    await expect(rowA).toHaveCount(1);
    await expect(rowA.getByTestId('study-set-name')).toHaveText('Hanja words');
    await expect(rowA.getByTestId('study-set-mode')).toHaveText('On schedule');
    await expect(rowA.getByTestId('study-set-count')).toHaveText('3 due · 3 cards');

    // Studying the set on schedule: the normal FSRS queue restricted to the set's filter.
    await rowA.getByTestId('study-set-start').click();
    await expect(pageA.getByTestId('study-filter-chip')).toContainText('Hanja words');
    await expect(pageA.getByTestId('count-new')).toHaveText('3');
    await expect(pageA.getByTestId('study-card')).not.toContainText('약속');

    // Sync to device B: the set arrives with its name, mode and filter.
    await syncNow(pageA);
    await expect
      .poll(async () => {
        await openPanel(pageB);
        const n = await pageB.getByTestId('study-set-row').count();
        await pageB.getByTestId('study-filter-close').click();
        return n;
      })
      .toBe(1);
    await openPanel(pageB);
    const rowB = pageB.getByTestId('study-set-row');
    await expect(rowB.getByTestId('study-set-name')).toHaveText('Hanja words');

    // Device B is studying Japanese: the set still runs on its own deck (Korean #hanja), and its
    // row counts exactly what starting it queues.
    await pageB.getByTestId('study-filter-close').click();
    await pageB
      .getByLabel('Select deck to study')
      .selectOption({ label: 'Japanese Essentials (JA)' });
    await openPanel(pageB);
    await expect(rowB.getByTestId('study-set-count')).toHaveText('3 due · 3 cards');
    await rowB.getByTestId('study-set-start').click();
    await expect(pageB.getByTestId('study-filter-chip')).toContainText('Hanja words');
    await expect(pageB.getByTestId('count-new')).toHaveText('3');
    await expect(pageB.getByTestId('study-card')).not.toContainText('약속');
    await pageB.getByTestId('study-filter-clear').click();
    await pageB.getByLabel('Select deck to study').selectOption({ label: 'All Decks' });
    await openPanel(pageB);

    // Device B renames it, then saves a practice-mode set (#daily); both sync back to A.
    await rowB.getByTestId('study-set-rename').click();
    await pageB.getByTestId('study-set-rename-input').fill('한자 단어');
    await pageB.getByTestId('study-set-rename-confirm').click();
    await expect(rowB.getByTestId('study-set-name')).toHaveText('한자 단어');
    await pageB.getByTestId('study-filter-category-toggle').click();
    await pageB.getByTestId('study-filter-category-option-daily').locator('xpath=..').click();
    await pageB.getByTestId('study-filter-save-custom').click();
    await pageB.getByTestId('study-set-name-input').fill('Daily cram');
    await pageB.getByTestId('study-set-mode-select').selectOption('practice');
    await pageB.getByTestId('study-set-save-confirm').click();
    await expect(pageB.getByTestId('study-set-row')).toHaveCount(2);
    await syncNow(pageB);

    await openStudy(pageA);
    await pageA.getByTestId('study-filter-clear').click();
    await expect
      .poll(async () => {
        await openPanel(pageA);
        const names = await pageA.getByTestId('study-set-name').allTextContents();
        await pageA.getByTestId('study-filter-close').click();
        return names;
      })
      .toEqual(['Daily cram', '한자 단어']);

    // A practice-mode set crams every match (학교, 약속) and records no FSRS review.
    await openPanel(pageA);
    const cramRow = pageA.getByTestId('study-set-row').filter({ hasText: 'Daily cram' });
    await expect(cramRow.getByTestId('study-set-mode')).toHaveText('Practice');
    await cramRow.getByTestId('study-set-start').click();
    await expect(pageA.getByTestId('study-filter-chip')).toContainText('Daily cram · practice');
    await expect(pageA.getByTestId('count-new')).toHaveText('2');
    await pageA.keyboard.press('Space');
    await pageA.keyboard.press('2');
    await expect(pageA.getByTestId('count-new')).toHaveText('1');
    await expect
      .poll(() => countStoredEvents(pageA, 'flashcards-db-p9setsa', 'PracticeRecorded'))
      .toBe(1);
    expect(await countStoredEvents(pageA, 'flashcards-db-p9setsa', 'ReviewRecorded')).toBe(0);
    await pageA.getByTestId('study-filter-clear').click();
    await expect(pageA.getByTestId('count-new')).toHaveText('4');

    // Delete on A (two-step confirm) and the deletion syncs to B.
    await openPanel(pageA);
    const delRow = pageA.getByTestId('study-set-row').filter({ hasText: 'Daily cram' });
    await delRow.getByTestId('study-set-delete').click();
    await expect(delRow.getByTestId('study-set-delete')).toHaveText('Confirm delete');
    await delRow.getByTestId('study-set-delete').click();
    await expect(pageA.getByTestId('study-set-row')).toHaveCount(1);
    await syncNow(pageA);
    await openStudy(pageB);
    await expect
      .poll(async () => {
        await openPanel(pageB);
        const names = await pageB.getByTestId('study-set-name').allTextContents();
        await pageB.getByTestId('study-filter-close').click();
        return names;
      })
      .toEqual(['한자 단어']);

    await context.close();
  });

  test('Custom study: extra new cards today, review ahead and practice (cram) that never changes FSRS', async ({
    page,
  }) => {
    const db = 'flashcards-db-p9custom';
    await page.clock.install();
    await page.goto('/?device=p9custom');
    await expect(page.getByTestId('study-card')).toBeVisible();

    // Limit Korean to 1 new card per day.
    await page.getByRole('button', { name: 'Library' }).first().click();
    const koRow = page.locator('[data-testid^="deck-row-"]', { hasText: KOREAN });
    await koRow.getByRole('button', { name: 'Options' }).click();
    const newPerDay = koRow.getByLabel('New cards / day');
    await newPerDay.fill('1');
    await newPerDay.blur();
    await openStudy(page);
    await page.getByLabel('Select deck to study').selectOption({ label: KOREAN });
    await expect(page.getByTestId('count-new')).toHaveText('1');

    // Extra new cards today raises today's limit (NewCardLimitRaised), FSRS untouched.
    await openPanel(page);
    await page.getByTestId('custom-extra-new-count').fill('2');
    await page.getByTestId('custom-extra-new-apply').click();
    await expect(page.getByTestId('study-filter-panel')).toHaveCount(0);
    await expect(page.getByTestId('count-new')).toHaveText('3');
    await expect.poll(() => countStoredEvents(page, db, 'NewCardLimitRaised')).toBe(1);

    // Learn the first card with Easy: it is not due again for days.
    await expect(page.getByTestId('study-card')).toContainText('학교');
    await page.keyboard.press('Space');
    await page.getByTestId('rate-easy').click();
    await expect(page.getByTestId('count-new')).toHaveText('2');
    await expect(page.getByTestId('count-due')).toHaveText('0');

    // Next study day: the raise has expired and nothing is due. Review ahead 30 days brings the
    // card back early as a real FSRS review.
    await page.clock.fastForward('24:00:00');
    await page.getByLabel('Select deck to study').selectOption({ label: 'All Decks' });
    await page.getByLabel('Select deck to study').selectOption({ label: KOREAN });
    await expect(page.getByTestId('count-new')).toHaveText('1');
    await expect(page.getByTestId('count-due')).toHaveText('0');
    await openPanel(page);
    await page.getByTestId('custom-ahead-days').fill('30');
    await expect(page.getByTestId('custom-ahead-count')).toHaveText('1');
    await page.getByTestId('custom-ahead-start').click();
    await expect(page.getByTestId('study-filter-chip')).toContainText('Review ahead 30d');
    await expect(page.getByTestId('count-due')).toHaveText('1');
    await expect(page.getByTestId('study-card')).toContainText('학교');
    await page.keyboard.press('Space');
    await page.getByTestId('rate-good').click();
    await expect(page.getByTestId('count-due')).toHaveText('0');
    await expect.poll(() => countStoredEvents(page, db, 'ReviewRecorded')).toBe(2);
    await page.getByTestId('study-filter-clear').click();
    await expect(page.getByTestId('count-new')).toHaveText('1');

    // Practice (cram): every Korean card, PracticeRecorded only, Again goes to the back.
    await openPanel(page);
    await expect(page.getByTestId('custom-practice-count')).toHaveText('4');
    await page.getByTestId('custom-practice-start').click();
    await expect(page.getByTestId('study-filter-chip')).toContainText('Practice');
    const total = () =>
      Promise.all(
        ['count-new', 'count-learning', 'count-due'].map(async (id) =>
          Number(await page.getByTestId(id).textContent()),
        ),
      ).then((xs) => xs.reduce((a, b) => a + b, 0));
    await expect.poll(total).toBe(4);
    const firstText = await page.getByTestId('study-card').textContent();
    await page.keyboard.press('Space');
    await page.keyboard.press('1');
    await expect.poll(total).toBe(4);
    await expect(page.getByTestId('study-card')).not.toHaveText(firstText ?? '');
    await page.keyboard.press('Space');
    await page.keyboard.press('2');
    await expect.poll(total).toBe(3);
    // Undo the last practice answer (PracticeUndone), not a review.
    await page.keyboard.press('z');
    await expect.poll(total).toBe(4);
    await expect.poll(() => countStoredEvents(page, db, 'PracticeRecorded')).toBe(2);
    await expect.poll(() => countStoredEvents(page, db, 'PracticeUndone')).toBe(1);
    expect(await countStoredEvents(page, db, 'ReviewRecorded')).toBe(2);
    expect(await countStoredEvents(page, db, 'ReviewUndone')).toBe(0);

    // Back on schedule: practice changed nothing.
    await page.getByTestId('study-filter-clear').click();
    await expect(page.getByTestId('count-new')).toHaveText('1');
    await expect(page.getByTestId('count-due')).toHaveText('0');
    await expect(page.getByTestId('count-learning')).toHaveText('0');
  });

  test('Leech auto-suspend (default off) suspends the card whose review reaches 8 lapses', async ({
    page,
  }) => {
    const db = 'flashcards-db-p9leech';
    await page.goto('/?device=p9leech');
    await expect(page.getByTestId('study-card')).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('leech-auto-suspend-toggle')).not.toBeChecked();
    await page.getByTestId('sync-now-btn').click();
    await expect(page.getByTestId('sync-status-pill')).toHaveText('Synced');

    // A remote device reviewed 학교 and 도서관 into 7 lapses each, both due now.
    const koDeck = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
    const rec = (key: string) =>
      deriveCardId(deriveNoteId(koDeck, key), 'layout:vocab-ko:recognition', 0);
    const DAY = 86_400_000;
    const start = Date.now() - 300 * DAY;
    const factory = createEventFactory('device-leech', 0, createHlcState('device-leech', start));
    const remote: FlashEvent[] = [];
    let n = 0;
    const review = (cardId: string, rating: ReviewRating, at: number) => {
      n += 1;
      remote.push(
        factory.create(
          'ReviewRecorded',
          {
            review_id: `leech-rev-${n}`,
            card_id: cardId,
            rating,
            reviewed_at: at,
            tz_offset: 0,
            duration_ms: 900,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: at,
          },
          at,
        ),
      );
    };
    for (const [i, key] of ['ko-1', 'ko-2'].entries()) {
      let t = start + i * 3_600_000;
      review(rec(key), 3, t);
      review(rec(key), 3, (t += 600_000));
      for (let lapse = 0; lapse < 7; lapse++) {
        review(rec(key), 1, (t += 10 * DAY));
        review(rec(key), 3, (t += 600_000));
      }
    }
    // Sanity check the history with core replay (same code the app runs).
    const sample = createEventFactory('seed', 0, createHlcState('seed', start - DAY));
    const check: CollectionState = replayAllEvents([...buildSampleDeckEvents(sample), ...remote]);
    for (const key of ['ko-1', 'ko-2']) {
      const card = check.cards.get(rec(key));
      expect(card?.schedule.lapses).toBe(7);
      expect(card?.schedule.state).toBe(2);
      expect(card?.schedule.due ?? Infinity).toBeLessThan(Date.now());
    }

    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
    const seg = b64(encodeEventsSegment(remote));
    const head = b64(
      encodeDeviceHead({
        device_id: 'device-leech',
        last_segment: 1,
        last_seq: remote.length,
        updated_at: Date.now(),
        segments: [{ seg: 1, from_seq: 1, to_seq: remote.length, count: remote.length }],
      }),
    );
    await page.evaluate(
      ({ segB64, headB64 }) => {
        const prefix = 'flashcards-dev-sync:';
        localStorage.setItem(
          `${prefix}sync/v1/devices/device-leech/seg-000001.jsonl.gz`,
          JSON.stringify({ b64: segB64, updatedAt: Date.now() }),
        );
        localStorage.setItem(
          `${prefix}sync/v1/devices/device-leech/head.json`,
          JSON.stringify({ b64: headB64, updatedAt: Date.now() }),
        );
      },
      { segB64: seg, headB64: head },
    );
    await page.getByTestId('sync-now-btn').click();
    await expect(page.getByTestId('sync-status-pill')).toHaveText('Synced');

    await openStudy(page);
    await page.getByLabel('Select deck to study').selectOption({ label: KOREAN });
    await expect(page.getByTestId('count-due')).toHaveText('2');

    // Setting off: the 8th lapse makes a leech but does not suspend it.
    const firstWord = (await page.getByTestId('study-card').textContent())?.includes('학교')
      ? '학교'
      : '도서관';
    const secondWord = firstWord === '학교' ? '도서관' : '학교';
    await page.keyboard.press('Space');
    await page.keyboard.press('1');
    await expect(page.getByTestId('count-due')).toHaveText('1');
    expect(await countStoredEvents(page, db, 'CardSuspended')).toBe(0);

    // Setting on (synced preference): the next card's 8th lapse appends one CardSuspended.
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByTestId('leech-auto-suspend-toggle').check();
    await expect(page.getByTestId('leech-auto-suspend-toggle')).toBeChecked();
    await openStudy(page);
    await expect(page.getByTestId('study-card')).toContainText(secondWord);
    await page.keyboard.press('Space');
    await page.keyboard.press('1');
    await expect.poll(() => countStoredEvents(page, db, 'CardSuspended')).toBe(1);
    await expect(page.getByTestId('count-due')).toHaveText('0');

    // Browse: both are leeches, only the second is suspended.
    await page.getByRole('button', { name: 'Browse' }).first().click();
    await page.getByLabel('Filter by deck').selectOption({ label: KOREAN });
    await page.getByTestId('browse-state-filter').selectOption('suspended');
    await expect(page.getByTestId('browse-list')).toContainText(secondWord);
    await expect(page.getByTestId('browse-list')).not.toContainText(firstWord);
    await page.getByTestId('browse-state-filter').selectOption('leech');
    await expect(page.getByTestId('browse-list')).toContainText(secondWord);
    await expect(page.getByTestId('browse-list')).toContainText(firstWord);

    // Undo the review: the auto-suspension is undone with it.
    await openStudy(page);
    await page.keyboard.press('z');
    await expect.poll(() => countStoredEvents(page, db, 'CardUnsuspended')).toBe(1);
    await expect(page.getByTestId('study-card')).toContainText(secondWord);
    await expect(page.getByTestId('count-due')).toHaveText('1');
  });
});
