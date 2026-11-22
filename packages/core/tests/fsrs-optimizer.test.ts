import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  buildRetentionParamsPayload,
  createEventFactory,
  getActiveFsrsParamsVersion,
  resolveDeckFsrsConfig,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import type { FlashEvent } from '../src/events/types.ts';
import {
  DEFAULT_FSRS_CONFIG,
  applyReviewToSchedule,
  createInitialSchedule,
} from '../src/fsrs/scheduler.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import type { ReviewRating } from '../src/model/types.ts';
import {
  FSRS6_WEIGHT_COUNT,
  OPTIMIZER_MIN_REVIEWS,
  buildOptimizedParamsPayload,
  buildTrainingBatch,
  collectOptimizerDataset,
  countEligibleReviews,
  estimateRetention,
  getCurrentDeckWeights,
  getOptimizerReadiness,
  normalizeOptimizedWeights,
  type OptimizerHistory,
} from '../src/optimizer/fsrs-optimizer.ts';

const DECK = 'deck-ko-optimizer';
const LAYOUT = 'layout:vocab-ko:recognition';
const KEYS = ['학교', '도서관', '약속'];
const cardIdFor = (i: number) => deriveCardId(deriveNoteId(DECK, KEYS[i] ?? ''), LAYOUT, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;
// 2026-03-01 00:00 KST (+09:00) expressed in UTC.
const BASE = Date.UTC(2026, 2, 1, 0, 0, 0) - 9 * HOUR;

interface ReviewSpec {
  card: number;
  at: number;
  rating: ReviewRating;
  tz?: number;
  id?: string;
}

function seedEvents(f: EventFactory, dayStartHour?: number): FlashEvent[] {
  const events: FlashEvent[] = [
    f.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: '한국어',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        ...(dayStartHour !== undefined ? { settings: { day_start_hour: dayStartHour } } : {}),
      },
      BASE - DAY,
    ),
  ];
  KEYS.forEach((key, i) => {
    events.push(
      f.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(DECK, key),
          deck_id: DECK,
          source_key: key,
          fields: { word: key, meaning: `m${i}` },
          created_order: i,
        },
        BASE - DAY + i + 1,
      ),
    );
  });
  return events;
}

function reviewEvent(f: EventFactory, spec: ReviewSpec, n: number): FlashEvent {
  return f.create(
    'ReviewRecorded',
    {
      review_id: spec.id ?? `rev-${n}`,
      card_id: cardIdFor(spec.card),
      rating: spec.rating,
      reviewed_at: spec.at,
      tz_offset: spec.tz ?? 540,
      duration_ms: 1000,
      answer_mode: 'flip',
      fsrs_params_version: 0,
      resulting_due_at: spec.at,
    },
    spec.at,
  );
}

function buildState(
  reviews: readonly ReviewSpec[],
  opts: { dayStartHour?: number; extra?: (f: EventFactory) => FlashEvent[] } = {},
): CollectionState {
  const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE - 2 * DAY));
  const events = seedEvents(f, opts.dayStartHour);
  reviews.forEach((r, i) => events.push(reviewEvent(f, r, i)));
  if (opts.extra) events.push(...opts.extra(f));
  const state = createEmptyState();
  applyEvents(state, events);
  return state;
}

describe('collectOptimizerDataset', () => {
  it('measures delta_t in study days with the review tz offset and deck rollover hour', () => {
    // 03:00 and 05:00 KST on the same calendar day straddle the 04:00 rollover.
    const state = buildState([
      { card: 0, at: BASE + 3 * HOUR, rating: 3 },
      { card: 0, at: BASE + 5 * HOUR, rating: 3 },
      { card: 0, at: BASE + 5 * HOUR + 10 * 60_000, rating: 3 },
      { card: 0, at: BASE + 3 * DAY + 12 * HOUR, rating: 1 },
    ]);
    const ds = collectOptimizerDataset(state, DECK);
    expect(ds.histories).toHaveLength(1);
    expect(ds.histories[0]?.reviews).toEqual([
      { rating: 3, delta_t: 0 },
      { rating: 3, delta_t: 1 },
      { rating: 3, delta_t: 0 },
      { rating: 1, delta_t: 3 },
    ]);
    expect(ds.review_count).toBe(4);
    // Targets: the 2nd (new study day) and 4th review; the first and the same-day repeat are not.
    expect(ds.eligible_review_count).toBe(2);
  });

  it('uses a deck day-start override instead of the collection default', () => {
    const reviews: ReviewSpec[] = [
      { card: 0, at: BASE + 3 * HOUR, rating: 3 },
      { card: 0, at: BASE + 5 * HOUR, rating: 3 },
    ];
    expect(collectOptimizerDataset(buildState(reviews), DECK).eligible_review_count).toBe(1);
    const midnight = collectOptimizerDataset(buildState(reviews, { dayStartHour: 0 }), DECK);
    expect(midnight.histories[0]?.reviews[1]?.delta_t).toBe(0);
    expect(midnight.eligible_review_count).toBe(0);
  });

  it('drops undone reviews, clamps clock/timezone skew to 0 and ignores other decks', () => {
    const state = buildState(
      [
        { card: 1, at: BASE + 10 * HOUR, rating: 3, id: 'keep-1' },
        { card: 1, at: BASE + 2 * DAY + 10 * HOUR, rating: 3, id: 'keep-2' },
        // Travelling west an hour later lands on an earlier local study day (delta -1 -> 0).
        { card: 1, at: BASE + 2 * DAY + 11 * HOUR, rating: 2, tz: -600, id: 'skew' },
        { card: 1, at: BASE + 5 * DAY, rating: 1, id: 'undo-me' },
      ],
      { extra: (f) => [f.create('ReviewUndone', { review_id: 'undo-me' }, BASE + 6 * DAY)] },
    );
    const ds = collectOptimizerDataset(state, DECK);
    expect(ds.review_count).toBe(3);
    expect(ds.histories[0]?.reviews).toEqual([
      { rating: 3, delta_t: 0 },
      { rating: 3, delta_t: 2 },
      { rating: 2, delta_t: 0 },
    ]);
    expect(ds.eligible_review_count).toBe(1);
    expect(collectOptimizerDataset(state, 'other-deck').histories).toEqual([]);
  });

  it('orders cards by their first review so the dataset does not depend on event order', () => {
    const state = buildState([
      { card: 2, at: BASE + 1 * HOUR, rating: 3 },
      { card: 0, at: BASE + 2 * HOUR, rating: 3 },
      { card: 1, at: BASE + 30 * 60_000, rating: 3 },
    ]);
    expect(collectOptimizerDataset(state, DECK).histories.map((h) => h.card_id)).toEqual([
      cardIdFor(1),
      cardIdFor(2),
      cardIdFor(0),
    ]);
  });
});

describe('training batch and readiness', () => {
  const histories: OptimizerHistory[] = [
    {
      card_id: 'a',
      reviews: [
        { rating: 3, delta_t: 0 },
        { rating: 3, delta_t: 0 },
        { rating: 3, delta_t: 2 },
        { rating: 1, delta_t: 5 },
      ],
    },
    { card_id: 'b', reviews: [{ rating: 4, delta_t: 0 }] },
  ];

  it('emits one item per eligible review holding the history up to it', () => {
    const batch = buildTrainingBatch(histories);
    expect(batch.item_count).toBe(2);
    expect(Array.from(batch.lengths)).toEqual([3, 4]);
    expect(Array.from(batch.ratings)).toEqual([3, 3, 3, 3, 3, 3, 1]);
    expect(Array.from(batch.delta_ts)).toEqual([0, 0, 2, 0, 0, 2, 5]);
    expect(countEligibleReviews(histories[0]?.reviews ?? [])).toBe(2);
  });

  it('requires the minimum number of eligible reviews', () => {
    expect(OPTIMIZER_MIN_REVIEWS).toBe(400);
    expect(getOptimizerReadiness({ eligible_review_count: 12 })).toEqual({
      ready: false,
      eligible: 12,
      required: 400,
      missing: 388,
    });
    expect(getOptimizerReadiness({ eligible_review_count: 400 }).ready).toBe(true);
    expect(getOptimizerReadiness({ eligible_review_count: 3 }, 3).missing).toBe(0);
  });
});

describe('normalizeOptimizedWeights', () => {
  const base = getCurrentDeckWeights(createEmptyState(), DECK, BASE);

  it('accepts 21 finite weights, rounding to 4 decimals and clipping to FSRS-6 bounds', () => {
    expect(base).toHaveLength(FSRS6_WEIGHT_COUNT);
    const raw = Float32Array.from(base);
    raw[0] = 500;
    raw[1] = 1.234567;
    const out = normalizeOptimizedWeights(raw);
    expect(out).not.toBeNull();
    expect(out?.[0]).toBe(100);
    expect(out?.[1]).toBe(1.2346);
    expect(out).toHaveLength(FSRS6_WEIGHT_COUNT);
  });

  it('rejects wrong lengths and non-finite values', () => {
    expect(normalizeOptimizedWeights(base.slice(0, 19))).toBeNull();
    expect(normalizeOptimizedWeights([])).toBeNull();
    const bad = [...base];
    bad[4] = Number.NaN;
    expect(normalizeOptimizedWeights(bad)).toBeNull();
  });
});

describe('estimateRetention', () => {
  it('scores only eligible reviews and returns zeros when there are none', () => {
    const w = getCurrentDeckWeights(createEmptyState(), DECK, BASE);
    expect(estimateRetention([], w)).toEqual({
      reviews: 0,
      measured_retention: 0,
      predicted_retention: 0,
      log_loss: 0,
    });
    const est = estimateRetention(
      [
        {
          card_id: 'a',
          reviews: [
            { rating: 3, delta_t: 0 },
            { rating: 3, delta_t: 3 },
            { rating: 1, delta_t: 10 },
            { rating: 3, delta_t: 0 },
          ],
        },
      ],
      w,
    );
    expect(est.reviews).toBe(2);
    expect(est.measured_retention).toBe(0.5);
    expect(est.predicted_retention).toBeGreaterThan(0);
    expect(est.predicted_retention).toBeLessThan(1);
    expect(est.log_loss).toBeGreaterThan(0);
  });

  it('prefers weights whose forgetting curve matches the history', () => {
    // Every long gap is forgotten: weights with tiny initial stability should fit better.
    const histories: OptimizerHistory[] = Array.from({ length: 20 }, (_, i) => ({
      card_id: `c${i}`,
      reviews: [
        { rating: 3, delta_t: 0 },
        { rating: 1, delta_t: 30 },
      ],
    }));
    const defaults = getCurrentDeckWeights(createEmptyState(), DECK, BASE);
    const forgetful = [...defaults];
    forgetful[2] = 0.05; // S0(Good)
    expect(estimateRetention(histories, forgetful).log_loss).toBeLessThan(
      estimateRetention(histories, defaults).log_loss,
    );
  });
});

describe('buildOptimizedParamsPayload', () => {
  const reviews: ReviewSpec[] = [
    { card: 0, at: BASE + 10 * HOUR, rating: 3 },
    { card: 0, at: BASE + 4 * DAY + 10 * HOUR, rating: 3 },
    { card: 1, at: BASE + 11 * HOUR, rating: 2 },
    { card: 1, at: BASE + 2 * DAY + 11 * HOUR, rating: 1 },
  ];
  const weights = (() => {
    const w = getCurrentDeckWeights(createEmptyState(), DECK, BASE);
    w[2] = 9.5;
    w[3] = 20;
    return normalizeOptimizedWeights(w) ?? [];
  })();

  function replayWith(cardIndex: number, w: readonly number[] | undefined) {
    let schedule = createInitialSchedule(0);
    for (const r of reviews.filter((x) => x.card === cardIndex)) {
      schedule = applyReviewToSchedule(schedule, r.rating, r.at, {
        ...DEFAULT_FSRS_CONFIG,
        ...(w ? { w } : {}),
      }).next;
    }
    return schedule;
  }

  it('builds the next params version keeping target retention and swapping weights', () => {
    const state = buildState(reviews);
    const nowMs = BASE + 10 * DAY;
    const payload = buildOptimizedParamsPayload(state, DECK, weights, {
      nowMs,
      rescheduleExisting: false,
    });
    expect(payload).toMatchObject({
      deck_id: DECK,
      params_version: getActiveFsrsParamsVersion(state, DECK) + 1,
      effective_from: nowMs,
      params: { request_retention: 0.9, w: weights, enable_fuzz: false },
    });
    expect('reschedule_existing' in payload).toBe(false);
    expect(
      buildOptimizedParamsPayload(state, DECK, weights, { nowMs, rescheduleExisting: true })
        .reschedule_existing,
    ).toBe(true);
  });

  it('only re-weights past reviews when reschedule_existing is set', () => {
    for (const reschedule of [false, true]) {
      const state = buildState(reviews);
      const nowMs = BASE + 10 * DAY;
      const payload = buildOptimizedParamsPayload(state, DECK, weights, {
        nowMs,
        rescheduleExisting: reschedule,
      });
      const f = createEventFactory('dev-b', 0, createHlcState('dev-b', nowMs));
      applyEvents(state, [f.create('DeckFSRSParamsChanged', payload, nowMs)]);
      for (const i of [0, 1]) {
        expect(state.cards.get(cardIdFor(i))?.schedule).toEqual(
          replayWith(i, reschedule ? weights : undefined),
        );
      }
      expect(getCurrentDeckWeights(state, DECK, nowMs + 1)).toEqual(weights);
    }
  });
});

describe('buildRetentionParamsPayload', () => {
  const weights = (() => {
    const w = getCurrentDeckWeights(createEmptyState(), DECK, BASE);
    w[2] = 9.5;
    w[3] = 20;
    return normalizeOptimizedWeights(w) ?? [];
  })();

  it('keeps optimized weights when only the target retention changes later', () => {
    const state = buildState([{ card: 0, at: BASE + 10 * HOUR, rating: 3 }]);
    const optimizedAt = BASE + 5 * DAY;
    const f = createEventFactory('dev-b', 0, createHlcState('dev-b', optimizedAt));
    applyEvents(state, [
      f.create(
        'DeckFSRSParamsChanged',
        buildOptimizedParamsPayload(state, DECK, weights, {
          nowMs: optimizedAt,
          rescheduleExisting: false,
        }),
        optimizedAt,
      ),
    ]);
    const editAt = optimizedAt + DAY;
    const payload = buildRetentionParamsPayload(state, DECK, 0.85, editAt);
    expect(payload).toMatchObject({
      deck_id: DECK,
      params_version: getActiveFsrsParamsVersion(state, DECK) + 1,
      effective_from: editAt,
      params: { request_retention: 0.85, w: weights },
    });
    applyEvents(state, [f.create('DeckFSRSParamsChanged', payload, editAt)]);
    const after = resolveDeckFsrsConfig(state, DECK, editAt + 1);
    expect(after.request_retention).toBe(0.85);
    expect(after.w).toEqual(weights);
    expect(getCurrentDeckWeights(state, DECK, editAt + 1)).toEqual(weights);
  });

  it('adds no weights when the deck still uses the defaults', () => {
    const state = buildState([]);
    const payload = buildRetentionParamsPayload(state, DECK, 0.8, BASE);
    expect(payload.params).toEqual({
      request_retention: 0.8,
      enable_fuzz: false,
      enable_short_term: true,
    });
  });
});
