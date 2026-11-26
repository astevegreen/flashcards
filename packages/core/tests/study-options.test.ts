import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makeReviewFixture, type ReviewFixture } from './helpers/review-fixture.ts';
import { computeStatePatch, mergeStatePatch } from '../src/events/patch.ts';
import { createEventFactory, replayAllEvents, type CollectionState } from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { KnownEvent } from '../src/events/types.ts';
import { getStudyDayIndex } from '../src/fsrs/scheduler.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId, FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import type { Card } from '../src/model/types.ts';
import { SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import {
  compareSeededRandom,
  compareSourceOrder,
  planCardOrderForAllDecks,
  resolveReviewOrder,
} from '../src/study/card-order.ts';
import { buildPracticeQueue, sortPracticeCards } from '../src/study/custom-study.ts';
import { compareHardestCards } from '../src/study/filter.ts';
import { buildStudyQueue } from '../src/study/queue.ts';

const DAY = 86_400_000;
const MIN = 60_000;
const KST = 540;
/** 2026-03-10 12:00 KST, well after the 04:00 rollover. */
const NOW = Date.UTC(2026, 2, 10, 3, 0, 0);
const KO_DECK = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
const REC = 'layout:vocab-ko:recognition';
const PROD = 'layout:vocab-ko:production';
const koCard = (n: number, layout = REC) =>
  deriveCardId(deriveNoteId(KO_DECK, `ko-${n}`), layout, 0);
const SCOPE = { nowMs: NOW, tzOffsetMinutes: KST };

type Fixture = ReviewFixture;

const makeFixture = (deviceId?: string): Fixture =>
  makeReviewFixture({ ...(deviceId ? { deviceId } : {}), withProduction: true });

/** Every Korean Recognition card graduated long ago (each due on a different day, all due now). */
function allReviewsDue(): Fixture {
  const fx = makeFixture();
  for (let n = 1; n <= 4; n++) {
    const at = NOW - (60 + n * 5) * DAY;
    fx.review(koCard(n), 3, at);
    fx.review(koCard(n), 3, at + 10 * MIN);
  }
  return fx;
}

const ids = (cards: readonly Card[]) => cards.map((c) => c.id);
const sorted = (values: readonly string[]) => [...values].sort();

function fakeCards(cardIds: readonly string[]): Card[] {
  return cardIds.map((id) => ({ id }) as Card);
}

describe('compareSeededRandom (seeded, reproducible shuffle)', () => {
  const idsArb = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
    minLength: 0,
    maxLength: 40,
  });

  it('gives the same order whatever the input order (a total order per seed)', () => {
    fc.assert(
      fc.property(idsArb, fc.string(), fc.integer(), (cardIds, seed, rot) => {
        const a = fakeCards(cardIds).sort(compareSeededRandom(seed));
        const shift = cardIds.length === 0 ? 0 : Math.abs(rot) % cardIds.length;
        const rotated = [...cardIds.slice(shift), ...cardIds.slice(0, shift)].reverse();
        const b = fakeCards(rotated).sort(compareSeededRandom(seed));
        expect(ids(b)).toEqual(ids(a));
        expect(sorted(ids(a))).toEqual(sorted(cardIds));
      }),
    );
  });

  it('never reorders the remaining cards when one is removed (stable mid-session)', () => {
    fc.assert(
      fc.property(idsArb, fc.string(), fc.nat(), (cardIds, seed, pick) => {
        fc.pre(cardIds.length > 1);
        const full = ids(fakeCards(cardIds).sort(compareSeededRandom(seed)));
        const removed = full[pick % full.length];
        const rest = ids(
          fakeCards(cardIds.filter((id) => id !== removed)).sort(compareSeededRandom(seed)),
        );
        expect(rest).toEqual(full.filter((id) => id !== removed));
      }),
    );
  });

  it('depends on the seed', () => {
    const cardIds = Array.from({ length: 12 }, (_, i) => `card-${i}`);
    const orders = new Set(
      ['1', '2', '3', '4'].map((seed) =>
        ids(fakeCards(cardIds).sort(compareSeededRandom(seed))).join(','),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('buildStudyQueue session order', () => {
  it('omitted order keeps the saved defaults (deck order: source new cards, due reviews)', () => {
    const state = makeFixture().state();
    const base = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK });
    const deck = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order: 'deck' });
    expect(ids(base.queue)).toEqual(ids(deck.queue));
    expect(ids(deck.queue)).toEqual(ids([...deck.queue].sort(compareSourceOrder(state))));
    expect(resolveReviewOrder(state, undefined)).toBe('deck');
  });

  it('random shuffles new cards reproducibly but keeps counts and the selected notes', () => {
    const state = makeFixture().state();
    const deck = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order: 'deck' });
    const random = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order: 'random' });
    const again = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order: 'random' });
    expect(random.counts).toEqual(deck.counts);
    expect(ids(again.queue)).toEqual(ids(random.queue));
    const notes = (q: readonly Card[]) => sorted(q.map((c) => c.note_id));
    expect(notes(random.queue)).toEqual(notes(deck.queue));
  });

  it('deck order overrides a deck whose new-card order is random (and vice versa)', () => {
    const fx = makeFixture();
    fx.events.push(
      fx.factory.create(
        'DeckSettingsChanged',
        { deck_id: KO_DECK, settings: { new_card_order: 'random' } },
        NOW - DAY,
      ),
    );
    const state = fx.state();
    const saved = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK });
    const random = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order: 'random' });
    const deck = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order: 'deck' });
    expect(ids(saved.queue)).toEqual(ids(random.queue));
    expect(ids(deck.queue)).toEqual(ids([...deck.queue].sort(compareSourceOrder(state))));
  });

  it('random reshuffles due reviews only after the daily review limit picked them', () => {
    const fx = allReviewsDue();
    fx.events.push(
      fx.factory.create(
        'DeckSettingsChanged',
        { deck_id: KO_DECK, settings: { max_reviews_per_day: 3, new_cards_per_day: 0 } },
        NOW - DAY,
      ),
    );
    const state = fx.state();
    const deck = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order: 'deck' });
    const random = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order: 'random' });
    expect(deck.counts.due).toBe(3);
    expect(random.counts).toEqual(deck.counts);
    // Same three (most overdue) reviews, by due in deck order.
    expect(sorted(ids(random.queue))).toEqual(sorted(ids(deck.queue)));
    const dues = deck.queue.map((c) => c.schedule.due);
    expect(dues).toEqual([...dues].sort((a, b) => a - b));
    expect(deck.queue.map((c) => c.id)).toEqual([koCard(4), koCard(3), koCard(2)]);
    const today = getStudyDayIndex(NOW, KST, 4);
    expect(ids(random.queue)).toEqual(
      ids([...deck.queue].sort(compareSeededRandom(`review:${today}`))),
    );
  });

  it('the synced study_order preference randomizes reviews like the session override', () => {
    const fx = allReviewsDue();
    fx.events.push(
      fx.factory.create('PreferencesChanged', { preferences: { study_order: 'random' } }, NOW),
    );
    const state = fx.state();
    expect(resolveReviewOrder(state, undefined)).toBe('random');
    expect(resolveReviewOrder(state, 'deck')).toBe('deck');
    const saved = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK });
    const random = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order: 'random' });
    const deck = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order: 'deck' });
    const reviews = (q: readonly Card[]) => ids(q.filter((c) => c.schedule.state === 2));
    expect(reviews(saved.queue)).toEqual(reviews(random.queue));
    expect(sorted(reviews(saved.queue))).toEqual(sorted(reviews(deck.queue)));
    expect(saved.counts).toEqual(deck.counts);
  });

  it('due learning cards stay first, by due, in every order', () => {
    const fx = allReviewsDue();
    fx.review(koCard(1, PROD), 1, NOW - 20 * MIN);
    const state = fx.state();
    for (const order of ['deck', 'random'] as const) {
      const q = buildStudyQueue(state, { ...SCOPE, deckId: KO_DECK, order });
      expect(q.counts.learning).toBe(1);
      expect(q.queue[0]?.id).toBe(koCard(1, PROD));
      // Note 1 was reviewed today: its other card is buried in both orders.
      expect(ids(q.queue)).not.toContain(koCard(1));
      expect(q.buriedNoteIds.has(deriveNoteId(KO_DECK, 'ko-1'))).toBe(true);
    }
  });

  it('never changes card schedules (pure)', () => {
    const state = allReviewsDue().state();
    const before = JSON.stringify([...state.cards.values()].map((c) => c.schedule));
    buildStudyQueue(state, { ...SCOPE, order: 'random' });
    buildPracticeQueue(state, { ...SCOPE, filter: {}, sessionId: 's', order: 'random' });
    expect(JSON.stringify([...state.cards.values()].map((c) => c.schedule))).toBe(before);
  });
});

describe('buildPracticeQueue order', () => {
  function lapsedState(): CollectionState {
    const fx = allReviewsDue();
    fx.review(koCard(2), 1, NOW - 2 * DAY);
    fx.review(koCard(2), 3, NOW - 2 * DAY + 10 * MIN);
    return fx.state();
  }
  const opts = { ...SCOPE, deckId: KO_DECK, filter: {} };

  it('every order practices the same cards', () => {
    const state = lapsedState();
    const legacy = buildPracticeQueue(state, { ...opts, sessionId: 's1' });
    for (const order of ['deck', 'random', 'hardest'] as const) {
      const q = buildPracticeQueue(state, { ...opts, sessionId: 's1', order });
      expect(q.counts.total).toBe(legacy.counts.total);
      expect(sorted(q.queue.map((c) => c.note_id))).toEqual(
        sorted(legacy.queue.map((c) => c.note_id)),
      );
    }
  });

  it('deck order is source order; hardest puts the lapsed card first', () => {
    const state = lapsedState();
    const deck = buildPracticeQueue(state, { ...opts, sessionId: 's1', order: 'deck' });
    expect(ids(deck.queue)).toEqual(ids([...deck.queue].sort(compareSourceOrder(state))));
    const hardest = buildPracticeQueue(state, { ...opts, sessionId: 's1', order: 'hardest' });
    expect(hardest.queue[0]?.id).toBe(koCard(2));
    expect(ids(hardest.queue)).toEqual(ids([...hardest.queue].sort(compareHardestCards)));
  });

  it('random is seeded by the session id: reproducible per session, varies across sessions', () => {
    const state = lapsedState();
    const a = buildPracticeQueue(state, { ...opts, sessionId: 's1', order: 'random' });
    const b = buildPracticeQueue(state, { ...opts, sessionId: 's1', order: 'random' });
    expect(ids(b.queue)).toEqual(ids(a.queue));
    const orders = new Set(
      ['s1', 's2', 's3', 's4', 's5', 's6'].map((sessionId) =>
        ids(buildPracticeQueue(state, { ...opts, sessionId, order: 'random' }).queue).join(','),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it('sortPracticeCards groups deck order by deck', () => {
    const state = makeFixture().state();
    const all = [...state.cards.values()];
    const out = sortPracticeCards(state, all, 'deck', 'seed');
    const deckIds = out.map((c) => c.deck_id);
    expect(deckIds).toEqual([...deckIds].sort());
    expect(sorted(ids(out))).toEqual(sorted(ids(all)));
  });
});

describe('study default preferences (events, LWW replay, snapshots)', () => {
  it('replay applies study_method / study_order LWW and ignores unknown values', () => {
    const fx = makeFixture();
    fx.events.push(
      fx.factory.create(
        'PreferencesChanged',
        { preferences: { study_method: 'practice', study_order: 'random' } },
        NOW,
      ),
      fx.factory.create(
        'PreferencesChanged',
        { preferences: { study_method: 'cram' as never, study_order: 'sideways' as never } },
        NOW + 1,
      ),
    );
    const state = fx.state();
    expect(state.preferences.study_method).toBe('practice');
    expect(state.preferences.study_order).toBe('random');
  });

  it('converges whatever the delivery order (two devices, last writer wins)', () => {
    const a = makeFixture('dev-a');
    const b = createEventFactory('dev-b', 0, createHlcState('dev-b', SAMPLE_SEED_EPOCH_MS));
    const e1 = a.factory.create(
      'PreferencesChanged',
      { preferences: { study_order: 'random' } },
      NOW,
    );
    const e2 = b.create('PreferencesChanged', { preferences: { study_order: 'deck' } }, NOW + MIN);
    const e3 = a.factory.create(
      'PreferencesChanged',
      { preferences: { study_method: 'practice' } },
      NOW + 2 * MIN,
    );
    const x = replayAllEvents([...a.events, e1, e2, e3]);
    const y = replayAllEvents([...a.events, e3, e2, e1]);
    expect(x.preferences.study_order).toBe('deck');
    expect(y.preferences.study_order).toBe('deck');
    expect(y.preferences.study_method).toBe('practice');
  });

  it('round-trips through snapshots and incremental state patches', () => {
    const fx = makeFixture();
    const before = fx.state();
    fx.events.push(
      fx.factory.create(
        'PreferencesChanged',
        { preferences: { study_method: 'practice', study_order: 'random' } },
        NOW,
      ),
    );
    const after = fx.state();
    const hydrated = deserializeCollectionState(
      JSON.parse(JSON.stringify(serializeCollectionState(after))) as ReturnType<
        typeof serializeCollectionState
      >,
    );
    expect(hydrated.preferences.study_method).toBe('practice');
    expect(hydrated.preferences.study_order).toBe('random');
    // Worker -> main thread patch carries the new preferences.
    const worker = replayAllEvents(fx.events.slice(0, -1));
    mergeStatePatch(before, computeStatePatch(worker, fx.events.slice(-1) as KnownEvent[]));
    expect(before.preferences.study_order).toBe('random');
    expect(before.preferences.study_method).toBe('practice');
    // A later, older-HLC write still loses after hydration (the LWW register survived).
    const stale = createEventFactory('dev-z', 0, createHlcState('dev-z', SAMPLE_SEED_EPOCH_MS));
    const old = stale.create('PreferencesChanged', { preferences: { study_order: 'deck' } }, 0);
    expect(replayAllEvents([...fx.events, old]).preferences.study_order).toBe('random');
  });

  it('planCardOrderForAllDecks writes each differing deck once and is idempotent', () => {
    const fx = makeFixture();
    const state = fx.state();
    expect(planCardOrderForAllDecks(state, 'deck')).toEqual([]);
    const plan = planCardOrderForAllDecks(state, 'random');
    expect(plan).toHaveLength(state.decks.size);
    expect(plan.map((p) => p.deck_id)).toEqual(sorted(plan.map((p) => p.deck_id)));
    for (const p of plan) fx.events.push(fx.factory.create('DeckSettingsChanged', p, NOW));
    const applied = fx.state();
    for (const deck of applied.decks.values()) expect(deck.settings.new_card_order).toBe('random');
    expect(planCardOrderForAllDecks(applied, 'random')).toEqual([]);
    // A later per-deck choice (Library deck options) overrides the all-decks default.
    fx.events.push(
      fx.factory.create(
        'DeckSettingsChanged',
        { deck_id: KO_DECK, settings: { new_card_order: 'source' } },
        NOW + MIN,
      ),
    );
    expect(fx.state().decks.get(KO_DECK)?.settings.new_card_order).toBe('source');
  });
});
