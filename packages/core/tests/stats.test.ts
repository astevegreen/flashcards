import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createEventFactory,
  replayAllEvents,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import type { FlashEvent, KnownEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId, FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import type { ReviewRating } from '../src/model/types.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import {
  classifyCardMaturity,
  computeCollectionStats,
  MATURE_INTERVAL_DAYS,
  studyDayToDateString,
  studyDayWeekday,
} from '../src/stats/index.ts';

const KST = 540;
const EST = -300;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Unix ms for a local wall-clock time at a given offset (minutes east of UTC). */
function local(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tzOffsetMinutes: number,
): number {
  return Date.UTC(y, mo - 1, d, h, mi) - tzOffsetMinutes * MS_PER_MINUTE;
}

const KO_DECK_ID = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
const JA_DECK_ID = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ja-vocab');

let reviewSeq = 0;
function review(
  factory: EventFactory,
  cardId: string,
  rating: ReviewRating,
  at: number,
  tzOffset: number,
  durationMs = 4000,
  reviewId?: string,
): KnownEvent {
  reviewSeq += 1;
  return factory.create(
    'ReviewRecorded',
    {
      review_id: reviewId ?? `rev-${String(reviewSeq).padStart(4, '0')}`,
      card_id: cardId,
      rating,
      reviewed_at: at,
      tz_offset: tzOffset,
      duration_ms: durationMs,
      answer_mode: 'flip',
      fsrs_params_version: 0,
      resulting_due_at: at,
    },
    at,
  );
}

function sampleState(): { state: CollectionState; factory: EventFactory; events: FlashEvent[] } {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', SAMPLE_SEED_EPOCH_MS));
  const events: FlashEvent[] = buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS);
  return { state: replayAllEvents(events), factory, events };
}

function deckCardIds(state: CollectionState, deckId: string): string[] {
  return [...(state.cardIdsByDeck.get(deckId) ?? [])].sort();
}

/** Korean sample collection plus a fixed review log spanning a DST-free KST week. */
function koreanGoldenFixture() {
  const { state: seeded, factory, events } = sampleState();
  const ko = deckCardIds(seeded, KO_DECK_ID);
  expect(ko.length).toBeGreaterThanOrEqual(4);
  const [c0, c1, c2, c3] = ko as [string, string, string, string];
  const ja = deckCardIds(seeded, JA_DECK_ID);
  const j0 = ja[0] as string;
  reviewSeq = 0;
  const log: KnownEvent[] = [
    // 학교: three consecutive study days in Seoul.
    review(factory, c0, 3, local(2026, 3, 8, 10, 0, KST), KST, 5000),
    review(factory, c0, 3, local(2026, 3, 9, 10, 0, KST), KST, 3000),
    review(factory, c0, 1, local(2026, 3, 10, 10, 0, KST), KST, 9000),
    // 도서관: 03:59 belongs to the previous study day (rollover 04:00), 04:00 to the new one.
    review(factory, c1, 3, local(2026, 3, 10, 3, 59, KST), KST, 2000),
    review(factory, c1, 2, local(2026, 3, 10, 4, 0, KST), KST, 6000),
    // 약속: reviewed while travelling (New York); bucketed by its own recorded offset.
    review(factory, c2, 4, local(2026, 3, 5, 23, 30, EST), EST, 1000),
    // 경험: reviewed then undone, so it must not appear anywhere.
    review(factory, c3, 1, local(2026, 3, 10, 11, 0, KST), KST, 7000, 'rev-undone'),
    factory.create('ReviewUndone', { review_id: 'rev-undone' }, local(2026, 3, 10, 11, 1, KST)),
    // Japanese deck activity, for the deck filter.
    review(factory, j0, 3, local(2026, 3, 10, 9, 0, KST), KST, 4000),
  ];
  const all = [...events, ...log];
  return { state: replayAllEvents(all), events: all, cards: { c0, c1, c2, c3, j0 } };
}

const NOW = local(2026, 3, 10, 12, 0, KST);

describe('Phase 11 stats: helpers', () => {
  it('labels study days with local dates and weekdays', () => {
    expect(studyDayToDateString(0)).toBe('1970-01-01');
    expect(studyDayWeekday(0)).toBe(4); // Thursday
    const day = Math.floor(Date.UTC(2026, 2, 10) / MS_PER_DAY);
    expect(studyDayToDateString(day)).toBe('2026-03-10');
    expect(studyDayWeekday(day)).toBe(2); // Tuesday
    expect(studyDayWeekday(-1)).toBe(3);
  });

  it('classifies maturity at the documented 21-day interval threshold', () => {
    const base = {
      due: 0,
      stability: 30,
      difficulty: 5,
      learning_steps: 0,
      reps: 3,
      lapses: 0,
    };
    expect(classifyCardMaturity({ ...base, state: 0, scheduled_days: 0 })).toBe('new');
    expect(classifyCardMaturity({ ...base, state: 1, scheduled_days: 0 })).toBe('learning');
    expect(classifyCardMaturity({ ...base, state: 3, scheduled_days: 40 })).toBe('learning');
    expect(
      classifyCardMaturity({ ...base, state: 2, scheduled_days: MATURE_INTERVAL_DAYS - 1 }),
    ).toBe('young');
    expect(classifyCardMaturity({ ...base, state: 2, scheduled_days: MATURE_INTERVAL_DAYS })).toBe(
      'mature',
    );
  });
});

describe('Phase 11 stats: Korean golden', () => {
  it('matches the golden stats for the Korean deck', async () => {
    const { state } = koreanGoldenFixture();
    const stats = computeCollectionStats(state, {
      nowMs: NOW,
      tzOffsetMinutes: KST,
      filter: { deckIds: [KO_DECK_ID] },
      historyDays: 7,
      forecastDays: 7,
      heatmapDays: 14,
      retentionWindowDays: 30,
    });
    await expect(`${JSON.stringify(stats, null, 2)}\n`).toMatchFileSnapshot(
      './__golden__/stats-ko.json.snap',
    );
  });

  it('buckets by study day, own tz offset and rollover hour, and drops undone reviews', () => {
    const { state } = koreanGoldenFixture();
    const stats = computeCollectionStats(state, {
      nowMs: NOW,
      tzOffsetMinutes: KST,
      filter: { deckIds: [KO_DECK_ID] },
      historyDays: 7,
      heatmapDays: 14,
    });
    expect(stats.today.date).toBe('2026-03-10');
    expect(stats.totals.reviews).toBe(6);
    expect(stats.totals.timeMs).toBe(5000 + 3000 + 9000 + 2000 + 6000 + 1000);

    const byDate = Object.fromEntries(stats.reviewsPerDay.days.map((d) => [d.date, d]));
    expect(stats.reviewsPerDay.days.map((d) => d.date)).toEqual([
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ]);
    // 약속 at 23:30 EST is the 5th locally, although it was already the 6th in Seoul.
    expect(byDate['2026-03-05']?.count).toBe(1);
    expect(byDate['2026-03-06']?.count).toBe(0);
    expect(byDate['2026-03-08']).toMatchObject({ count: 1, newCards: 1, timeMs: 5000 });
    // 학교 (Good) + 도서관 at 03:59 (before the 04:00 rollover).
    expect(byDate['2026-03-09']).toMatchObject({ count: 2, passed: 2, newCards: 1, timeMs: 5000 });
    // 학교 Again + 도서관 Hard at exactly 04:00; the undone 경험 review is gone.
    expect(byDate['2026-03-10']).toMatchObject({
      count: 2,
      passed: 1,
      again: 1,
      newCards: 0,
      timeMs: 15000,
    });
    expect(stats.reviewsPerDay.totalReviews).toBe(6);
    expect(stats.reviewsPerDay.daysStudied).toBe(4);

    expect(stats.heatmap.currentStreak).toBe(3);
    expect(stats.heatmap.longestStreak).toBe(3);
    expect(stats.heatmap.studiedToday).toBe(true);
    expect(stats.heatmap.totalDaysStudied).toBe(4);
    expect(stats.heatmap.maxCount).toBe(2);

    // 경험 is new again after the undo; the other three are in learning/review.
    expect(stats.maturity.total).toBe(stats.totals.cards);
    expect(stats.maturity.new).toBe(stats.totals.cards - 3);
    expect(stats.maturity.mature).toBe(0);
  });

  it('uses a deck day_start_hour override for bucketing', () => {
    const { events } = koreanGoldenFixture();
    const factory = createEventFactory('dev-b', 0, createHlcState('dev-b', NOW));
    const state = replayAllEvents([
      ...events,
      factory.create(
        'DeckSettingsChanged',
        { deck_id: KO_DECK_ID, settings: { day_start_hour: 0 } },
        NOW,
      ),
    ]);
    const stats = computeCollectionStats(state, {
      nowMs: NOW,
      tzOffsetMinutes: KST,
      filter: { deckIds: [KO_DECK_ID] },
      historyDays: 7,
    });
    const byDate = Object.fromEntries(stats.reviewsPerDay.days.map((d) => [d.date, d.count]));
    // With midnight rollover the 03:59 review moves to the 10th.
    expect(byDate['2026-03-09']).toBe(1);
    expect(byDate['2026-03-10']).toBe(3);
  });

  it('filters by deck and by an arbitrary card predicate', () => {
    const { state, cards } = koreanGoldenFixture();
    const opts = { nowMs: NOW, tzOffsetMinutes: KST };
    const all = computeCollectionStats(state, opts);
    const ko = computeCollectionStats(state, { ...opts, filter: { deckIds: [KO_DECK_ID] } });
    const ja = computeCollectionStats(state, {
      ...opts,
      filter: { deckIds: new Set([JA_DECK_ID]) },
    });
    expect(all.totals.reviews).toBe(7);
    expect(ko.totals.reviews).toBe(6);
    expect(ja.totals.reviews).toBe(1);
    expect(ja.deckIds).toEqual([JA_DECK_ID]);
    expect(all.deckIds.length).toBeGreaterThan(2);

    const only = computeCollectionStats(state, {
      ...opts,
      filter: { deckIds: [KO_DECK_ID], includeCard: (c) => c.id === cards.c0 },
    });
    expect(only.totals).toMatchObject({ cards: 1, reviews: 3 });

    const none = computeCollectionStats(state, { ...opts, filter: { deckIds: [] } });
    expect(none.totals).toEqual({ cards: 0, reviews: 0, passed: 0, timeMs: 0 });
    expect(none.retention.target).toBeNull();
  });

  it('excludes archived notes and decks', () => {
    const { events, cards, state: base } = koreanGoldenFixture();
    const note = base.cards.get(cards.c0)?.note_id as string;
    const factory = createEventFactory('dev-c', 0, createHlcState('dev-c', NOW));
    const state = replayAllEvents([
      ...events,
      factory.create('NoteArchived', { note_id: note }, NOW),
    ]);
    const opts = { nowMs: NOW, tzOffsetMinutes: KST };
    expect(
      computeCollectionStats(state, { ...opts, filter: { deckIds: [KO_DECK_ID] } }).totals.reviews,
    ).toBe(3);
    const archivedDeck = replayAllEvents([
      ...events,
      factory.create('DeckSettingsChanged', { deck_id: KO_DECK_ID, archived: true }, NOW),
    ]);
    const stats = computeCollectionStats(archivedDeck, opts);
    expect(stats.deckIds).not.toContain(KO_DECK_ID);
    expect(stats.totals.reviews).toBe(1);
  });
});

describe('Phase 11 stats: streaks', () => {
  function streakState(days: number[], tz = KST) {
    const { state: seeded, factory, events } = sampleState();
    const c0 = deckCardIds(seeded, KO_DECK_ID)[0] as string;
    const log = days.map((d) => review(factory, c0, 3, local(2026, 3, d, 20, 0, tz), tz));
    return replayAllEvents([...events, ...log]);
  }

  it('keeps the streak alive until a whole day passes without reviews', () => {
    const state = streakState([7, 8, 9]);
    const todayNoReviews = computeCollectionStats(state, { nowMs: NOW, tzOffsetMinutes: KST });
    expect(todayNoReviews.heatmap.studiedToday).toBe(false);
    expect(todayNoReviews.heatmap.currentStreak).toBe(3);

    const dayAfter = computeCollectionStats(state, {
      nowMs: local(2026, 3, 11, 12, 0, KST),
      tzOffsetMinutes: KST,
    });
    expect(dayAfter.heatmap.currentStreak).toBe(0);
    expect(dayAfter.heatmap.longestStreak).toBe(3);
  });

  it('still counts the previous day before the 04:00 rollover', () => {
    const state = streakState([8, 9]);
    const lateNight = computeCollectionStats(state, {
      nowMs: local(2026, 3, 11, 3, 30, KST),
      tzOffsetMinutes: KST,
    });
    // 03:30 on the 11th is still study day the 10th, so the 9th is "yesterday".
    expect(lateNight.today.date).toBe('2026-03-10');
    expect(lateNight.heatmap.currentStreak).toBe(2);
  });

  it('finds the longest streak outside the heatmap window and breaks on gaps', () => {
    const state = streakState([1, 2, 3, 4, 6, 9, 10]);
    const stats = computeCollectionStats(state, {
      nowMs: NOW,
      tzOffsetMinutes: KST,
      heatmapDays: 3,
    });
    expect(stats.heatmap.days.map((d) => d.date)).toEqual([
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ]);
    expect(stats.heatmap.currentStreak).toBe(2);
    expect(stats.heatmap.longestStreak).toBe(4);
    expect(stats.heatmap.totalDaysStudied).toBe(7);
  });

  it('crosses month and year boundaries', () => {
    const { state: seeded, factory, events } = sampleState();
    const c0 = deckCardIds(seeded, KO_DECK_ID)[0] as string;
    const log = [
      review(factory, c0, 3, local(2025, 12, 31, 22, 0, KST), KST),
      // 01:00 on Jan 1st is still the Dec 31st study day.
      review(factory, c0, 3, local(2026, 1, 1, 1, 0, KST), KST),
      review(factory, c0, 3, local(2026, 1, 1, 22, 0, KST), KST),
    ];
    const state = replayAllEvents([...events, ...log]);
    const stats = computeCollectionStats(state, {
      nowMs: local(2026, 1, 1, 23, 0, KST),
      tzOffsetMinutes: KST,
      historyDays: 2,
    });
    expect(stats.reviewsPerDay.days.map((d) => [d.date, d.count])).toEqual([
      ['2025-12-31', 2],
      ['2026-01-01', 1],
    ]);
    expect(stats.heatmap.currentStreak).toBe(2);
  });
});

describe('Phase 11 stats: retention, maturity, forecast', () => {
  function matureDeck() {
    const factory = createEventFactory('dev-m', 0, createHlcState('dev-m', SAMPLE_SEED_EPOCH_MS));
    const deckId = 'deck-ko-mature';
    const t0 = local(2026, 1, 1, 9, 0, KST);
    const noteIds = ['n1', 'n2', 'n3'].map((k) => deriveNoteId(deckId, k));
    const layoutId = 'layout:vocab-ko:recognition';
    const cardIds = noteIds.map((n) => deriveCardId(n, layoutId, 0));
    const events: FlashEvent[] = [
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: '한국어 Mature',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          settings: { target_retention: 0.85 },
          created_at: t0,
        },
        t0,
      ),
      ...noteIds.map((noteId, i) =>
        factory.create(
          'NoteUpserted',
          {
            note_id: noteId,
            deck_id: deckId,
            source_key: `n${i + 1}`,
            fields: { word: ['사과', '바다', '하늘'][i] as string, meaning: 'x' },
            tags: [],
          },
          t0,
        ),
      ),
    ];
    return { factory, deckId, cardIds, events, t0 };
  }

  it('separates mature, young and learning reviews in true retention', () => {
    const { factory, deckId, cardIds, events, t0 } = matureDeck();
    const [a, b] = cardIds as [string, string];
    const state0 = replayAllEvents(events);
    expect(state0.cards.has(a)).toBe(true);

    // Card a: keep answering Good on its due date until its interval is >= 21 days.
    const log: KnownEvent[] = [];
    let at = t0;
    let state = state0;
    for (let i = 0; i < 12; i++) {
      log.push(review(factory, a, 3, at, KST));
      state = replayAllEvents([...events, ...log]);
      const card = state.cards.get(a);
      if (!card) throw new Error('missing card');
      if (card.schedule.state === 2 && card.schedule.scheduled_days >= MATURE_INTERVAL_DAYS) break;
      at = Math.max(card.schedule.due, at + MS_PER_MINUTE);
    }
    const matureCard = state.cards.get(a);
    expect(matureCard?.schedule.scheduled_days).toBeGreaterThanOrEqual(MATURE_INTERVAL_DAYS);
    const dueA = matureCard?.schedule.due as number;

    // One mature pass, then one mature lapse later on.
    log.push(review(factory, a, 3, dueA, KST));
    state = replayAllEvents([...events, ...log]);
    const dueA2 = state.cards.get(a)?.schedule.due as number;
    log.push(review(factory, a, 1, dueA2, KST));

    // Card b: a learning-step review (excluded) then a young review once graduated.
    log.push(review(factory, b, 3, dueA2 - 3 * MS_PER_DAY, KST));
    state = replayAllEvents([...events, ...log]);
    const bDue = state.cards.get(b)?.schedule.due as number;
    log.push(review(factory, b, 3, Math.max(bDue, dueA2 - 2 * MS_PER_DAY), KST));
    state = replayAllEvents([...events, ...log]);
    const bCard = state.cards.get(b);
    if (bCard?.schedule.state === 2) {
      log.push(review(factory, b, 1, dueA2 - MS_PER_DAY, KST));
    }
    state = replayAllEvents([...events, ...log]);

    const nowMs = dueA2 + 60 * MS_PER_MINUTE;
    const stats = computeCollectionStats(state, {
      nowMs,
      tzOffsetMinutes: KST,
      filter: { deckIds: [deckId] },
      retentionWindowDays: 365,
    });
    // Every Review-state review of `a` once it was >= 21 days is mature.
    expect(stats.retention.mature.total).toBeGreaterThanOrEqual(2);
    expect(stats.retention.mature.passed).toBe(stats.retention.mature.total - 1);
    expect(stats.retention.all.total).toBe(
      stats.retention.mature.total + stats.retention.young.total,
    );
    expect(stats.retention.all.total).toBeLessThan(stats.totals.reviews);
    expect(stats.retention.target).toBe(0.85);
    expect(stats.retention.deckTargets).toEqual([{ deckId, target: 0.85 }]);

    // A short window only sees the most recent reviews.
    const narrow = computeCollectionStats(state, {
      nowMs,
      tzOffsetMinutes: KST,
      filter: { deckIds: [deckId] },
      retentionWindowDays: 1,
    });
    expect(narrow.retention.mature).toEqual({ passed: 0, total: 1, rate: 0 });

    // After the lapse `a` is relearning, which counts as learning.
    expect(stats.maturity.learning).toBeGreaterThanOrEqual(1);
    expect(stats.maturity.new).toBe(1);
  });

  it('forecasts due cards, folding overdue cards into today', () => {
    const { factory, deckId, cardIds, events, t0 } = matureDeck();
    const [a, b, c] = cardIds as [string, string, string];
    // a: learning (Again) due in minutes; b: Easy -> review due in days; c: new.
    const log = [review(factory, a, 1, t0, KST), review(factory, b, 4, t0, KST)];
    const state = replayAllEvents([...events, ...log]);
    const bDue = state.cards.get(b)?.schedule.due as number;
    expect(state.cards.get(c)?.schedule.state).toBe(0);

    const sameDay = computeCollectionStats(state, {
      nowMs: t0 + MS_PER_MINUTE,
      tzOffsetMinutes: KST,
      filter: { deckIds: [deckId] },
      forecastDays: 60,
    });
    expect(sameDay.forecast.days[0]).toMatchObject({ offset: 0, count: 1, learning: 1 });
    expect(sameDay.forecast.total).toBe(2);
    expect(sameDay.forecast.overdue).toBe(0);
    const bSlot = sameDay.forecast.days.find((d) => d.review === 1);
    expect(bSlot?.offset).toBeGreaterThan(0);

    // Much later both are overdue and land in today.
    const later = computeCollectionStats(state, {
      nowMs: bDue + 5 * MS_PER_DAY,
      tzOffsetMinutes: KST,
      filter: { deckIds: [deckId] },
      forecastDays: 3,
    });
    expect(later.forecast.overdue).toBe(2);
    expect(later.forecast.days[0]).toMatchObject({ count: 2, learning: 1, review: 1 });
    expect(later.forecast.days.map((d) => d.offset)).toEqual([0, 1, 2]);
  });
});

describe('Phase 11 stats: properties', () => {
  const reviewArb = fc.record({
    card: fc.integer({ min: 0, max: 3 }),
    rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4),
    minutes: fc.integer({ min: 0, max: 60 * 24 * 40 }),
    tz: fc.constantFrom(KST, EST, 0, 330),
    undo: fc.boolean(),
  });

  it('is order-independent and internally consistent', () => {
    fc.assert(
      fc.property(
        fc.array(reviewArb, { maxLength: 25 }),
        fc.integer({ min: 0, max: 1000 }),
        (specs, seed) => {
          const { state: seeded, factory, events } = sampleState();
          const ko = deckCardIds(seeded, KO_DECK_ID);
          const start = local(2026, 2, 1, 0, 0, KST);
          const log: KnownEvent[] = [];
          specs.forEach((s, i) => {
            const id = `p-${i}`;
            const at = start + s.minutes * MS_PER_MINUTE;
            log.push(review(factory, ko[s.card] as string, s.rating, at, s.tz, 1000, id));
            if (s.undo) log.push(factory.create('ReviewUndone', { review_id: id }, at + 1));
          });
          const nowMs = start + 41 * MS_PER_DAY;
          const opts = {
            nowMs,
            tzOffsetMinutes: KST,
            filter: { deckIds: [KO_DECK_ID] },
            historyDays: 60,
            heatmapDays: 60,
          };
          const a = computeCollectionStats(replayAllEvents([...events, ...log]), opts);

          // Deterministic shuffle of the review log (events are the truth, order is not).
          const shuffled = [...log];
          let x = seed + 1;
          for (let i = shuffled.length - 1; i > 0; i--) {
            x = (x * 1103515245 + 12345) % 2147483648;
            const j = x % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j] as KnownEvent, shuffled[i] as KnownEvent];
          }
          const b = computeCollectionStats(replayAllEvents([...events, ...shuffled]), opts);
          expect(b).toEqual(a);

          const active = specs.filter((s) => !s.undo).length;
          expect(a.totals.reviews).toBe(active);
          expect(a.reviewsPerDay.totalReviews).toBe(active);
          expect(a.heatmap.days.reduce((n, d) => n + d.count, 0)).toBe(active);
          const m = a.maturity;
          expect(m.new + m.learning + m.young + m.mature).toBe(m.total);
          expect(a.retention.all.total).toBeLessThanOrEqual(active);
          expect(a.heatmap.longestStreak).toBeGreaterThanOrEqual(a.heatmap.currentStreak);
        },
      ),
      { numRuns: 40 },
    );
  });
});
