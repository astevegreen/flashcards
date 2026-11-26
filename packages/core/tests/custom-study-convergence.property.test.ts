import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import type { ReviewRating } from '../src/model/types.ts';
import {
  buildPracticeQueue,
  buildReviewAheadQueue,
  getPracticeRecords,
  listStudySets,
} from '../src/study/custom-study.ts';
import { normalizeCardFilter } from '../src/study/filter.ts';
import { getExtraNewCardsToday } from './helpers/extra-new-cards.ts';
import { buildStudyQueue } from '../src/study/queue.ts';

const DECK = 'deck-ko-custom-study-prop';
const REC = 'layout:vocab-ko:recognition';
const PROD = 'layout:vocab-ko:production';
const NOTE_KEYS = ['학교', '도서관', '약속'];
const LAYOUTS = [REC, PROD];
const KST = 540;
const cardIdFor = (i: number) =>
  deriveCardId(deriveNoteId(DECK, NOTE_KEYS[i % 3] ?? ''), LAYOUTS[Math.floor(i / 3)] ?? REC, 0);

const NAMES = ['Trouble', '한자', 'Verbs'];
const FILTERS = [
  normalizeCardFilter({ deckIds: [DECK] }),
  normalizeCardFilter({ categories: { mode: 'any', tags: ['hanja'] } }),
  normalizeCardFilter({ deckIds: [DECK], performance: { minAgainCount: 1, hardest: 50 } }),
];

function shuffleWithSeed<T>(arr: readonly T[], s: number): T[] {
  const copy = [...arr];
  let x = s || 1;
  for (let i = copy.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

function replayChunked(list: readonly FlashEvent[], chunk: number): CollectionState {
  const st = createEmptyState();
  for (let i = 0; i < list.length; i += chunk) applyEvents(st, list.slice(i, i + chunk));
  return st;
}

function ids(cards: ReadonlyArray<{ id: string }>): string[] {
  return cards.map((c) => c.id);
}

function observe(st: CollectionState, nowMs: number) {
  const scope = { nowMs, tzOffsetMinutes: KST };
  const practice = (sessionId: string) => {
    const q = buildPracticeQueue(st, { ...scope, filter: FILTERS[0] ?? {}, sessionId });
    return { queue: ids(q.queue), practiced: q.practiced, again: q.again, counts: q.counts };
  };
  const queue = buildStudyQueue(st, { ...scope, deckId: DECK });
  return {
    studySets: listStudySets(st),
    practiceIds: getPracticeRecords(st).map((r) => r.practiceId),
    p0: practice('p0'),
    p1: practice('p1'),
    queue: ids(queue.queue),
    counts: queue.counts,
    extraNew: getExtraNewCardsToday(st, DECK, nowMs, KST, 4),
    ahead: ids(buildReviewAheadQueue(st, { ...scope, deckId: DECK, days: 7 }).queue),
    schedules: [0, 1, 2, 3, 4, 5].map((i) => st.cards.get(cardIdFor(i))?.schedule),
  };
}

function seedEvents(f0: EventFactory, base: number): FlashEvent[] {
  const events: FlashEvent[] = [
    f0.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: '한국어',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        settings: { new_cards_per_day: 1, enabled_layout_ids: [PROD, REC] },
      },
      base,
    ),
  ];
  NOTE_KEYS.forEach((key, i) => {
    events.push(
      f0.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(DECK, key),
          deck_id: DECK,
          source_key: key,
          fields: { word: key, meaning: `m${i}` },
          tags: i === 1 ? ['hanja'] : ['topik-1'],
          created_order: i,
        },
        base + i + 1,
      ),
    );
  });
  return events;
}

const deviceArb = fc.integer({ min: 0, max: 2 });
const actionArb = fc.oneof(
  fc.record({
    kind: fc.constant('save' as const),
    device: deviceArb,
    set: fc.integer({ min: 0, max: 2 }),
    name: fc.option(fc.integer({ min: 0, max: 2 }), { nil: undefined }),
    filter: fc.option(fc.integer({ min: 0, max: 2 }), { nil: undefined }),
    mode: fc.option(fc.constantFrom('schedule' as const, 'practice' as const), { nil: undefined }),
    dt: fc.integer({ min: -5_000, max: 60_000 }),
  }),
  fc.record({
    kind: fc.constant('delete' as const),
    device: deviceArb,
    set: fc.integer({ min: 0, max: 2 }),
    dt: fc.integer({ min: -5_000, max: 60_000 }),
  }),
  fc.record({
    kind: fc.constant('practice' as const),
    device: deviceArb,
    card: fc.integer({ min: 0, max: 5 }),
    rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4),
    session: fc.constantFrom('p0', 'p1'),
    dt: fc.integer({ min: 1, max: 120_000 }),
  }),
  fc.record({
    kind: fc.constant('undoPractice' as const),
    device: deviceArb,
    pick: fc.nat(),
    dt: fc.integer({ min: 1, max: 30_000 }),
  }),
  fc.record({
    kind: fc.constant('raise' as const),
    device: deviceArb,
    extra: fc.integer({ min: 1, max: 4 }),
    allDecks: fc.boolean(),
    dt: fc.integer({ min: 1, max: 60_000 }),
  }),
  fc.record({
    kind: fc.constant('review' as const),
    device: deviceArb,
    card: fc.integer({ min: 0, max: 5 }),
    rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4),
    dt: fc.integer({ min: 1, max: 400_000 }),
  }),
  fc.record({
    kind: fc.constant('suspend' as const),
    device: deviceArb,
    card: fc.integer({ min: 0, max: 5 }),
    on: fc.boolean(),
    dt: fc.integer({ min: 1, max: 60_000 }),
  }),
);
type Action = typeof actionArb extends fc.Arbitrary<infer A> ? A : never;

function buildLog(actions: readonly Action[]): { events: FlashEvent[]; nowMs: number } {
  const base = Date.UTC(2026, 2, 1, 1, 0, 0);
  // Skewed device clocks: HLC (not wall time) decides every LWW winner.
  const factories = [
    createEventFactory('dev-a', 0, createHlcState('dev-a', base)),
    createEventFactory('dev-b', 0, createHlcState('dev-b', base + 700)),
    createEventFactory('dev-c', 0, createHlcState('dev-c', base - 900)),
  ] as const;
  const [f0] = factories;
  const events = seedEvents(f0, base);
  const practiceIds: string[] = [];
  let clock = base + 1000;
  let n = 0;
  for (const act of actions) {
    clock += act.dt;
    n += 1;
    const f = factories[act.device] ?? f0;
    switch (act.kind) {
      case 'save': {
        const payload: Record<string, unknown> = { set_id: `set-${act.set}` };
        if (act.name !== undefined) payload['name'] = NAMES[act.name];
        if (act.filter !== undefined) payload['filter'] = FILTERS[act.filter];
        if (act.mode !== undefined) payload['mode'] = act.mode;
        if (Object.keys(payload).length === 1) payload['name'] = NAMES[0];
        events.push(f.create('StudySetSaved', payload as { set_id: string }, clock));
        break;
      }
      case 'delete':
        events.push(f.create('StudySetDeleted', { set_id: `set-${act.set}` }, clock));
        break;
      case 'practice': {
        const practiceId = `pr-${n}-${act.device}`;
        practiceIds.push(practiceId);
        events.push(
          f.create(
            'PracticeRecorded',
            {
              practice_id: practiceId,
              session_id: act.session,
              card_id: cardIdFor(act.card),
              rating: act.rating,
              practiced_at: clock,
              tz_offset: KST,
              duration_ms: 900,
              answer_mode: 'flip',
            },
            clock,
          ),
        );
        break;
      }
      case 'undoPractice': {
        const target = practiceIds[act.pick % Math.max(1, practiceIds.length)];
        if (target !== undefined) {
          events.push(f.create('PracticeUndone', { practice_id: target }, clock));
        }
        break;
      }
      case 'raise':
        events.push(
          f.create(
            'NewCardLimitRaised',
            {
              raise_id: `raise-${n}`,
              deck_ids: act.allDecks ? [] : [DECK],
              extra: act.extra,
              raised_at: clock,
              tz_offset: KST,
            },
            clock,
          ),
        );
        break;
      case 'review':
        events.push(
          f.create(
            'ReviewRecorded',
            {
              review_id: `r-${n}-${act.device}`,
              card_id: cardIdFor(act.card),
              rating: act.rating,
              reviewed_at: clock,
              tz_offset: KST,
              duration_ms: 1000,
              answer_mode: 'flip',
              fsrs_params_version: 0,
              resulting_due_at: clock,
            },
            clock,
          ),
        );
        break;
      case 'suspend':
        events.push(
          f.create(
            act.on ? 'CardSuspended' : 'CardUnsuspended',
            { card_id: cardIdFor(act.card) },
            clock,
          ),
        );
        break;
    }
  }
  return { events, nowMs: clock + 60_000 };
}

const isPractice = (e: FlashEvent) => e.type === 'PracticeRecorded' || e.type === 'PracticeUndone';

describe('Study Sets, practice and extra-new events converge (fast-check)', () => {
  it('any interleaving, chunking, duplicates and snapshot hydration replay identically', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 3, maxLength: 40 }),
        fc.integer({ min: 1, max: 100_000 }),
        (actions, seed) => {
          const { events, nowMs } = buildLog(actions);
          // Device A applied its log in creation order; device B got every chunk shuffled.
          const reference = observe(replayChunked(events, events.length), nowMs);
          const orders: FlashEvent[][] = [
            [...events].reverse(),
            shuffleWithSeed(events, seed),
            [
              ...shuffleWithSeed(events, seed + 1),
              ...shuffleWithSeed(events, seed + 2).slice(0, 9),
            ],
          ];
          for (const [i, order] of orders.entries()) {
            expect(observe(replayChunked(order, i + 1), nowMs)).toEqual(reference);
          }

          const cut = Math.floor(events.length / 2);
          const shuffled = shuffleWithSeed(events, seed + 3);
          const hydrated = deserializeCollectionState(
            JSON.parse(
              JSON.stringify(serializeCollectionState(replayChunked(shuffled.slice(0, cut), 4))),
            ) as ReturnType<typeof serializeCollectionState>,
          );
          applyEvents(hydrated, shuffled.slice(cut));
          expect(observe(hydrated, nowMs)).toEqual(reference);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('PracticeRecorded / PracticeUndone never change FSRS schedules or the scheduled queue', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 3, maxLength: 40 }),
        fc.integer({ min: 1, max: 100_000 }),
        (actions, seed) => {
          const { events, nowMs } = buildLog(actions);
          const order = shuffleWithSeed(events, seed);
          const withPractice = replayChunked(order, 3);
          const without = replayChunked(
            order.filter((e) => !isPractice(e)),
            3,
          );
          expect([...withPractice.cards.entries()].sort()).toEqual(
            [...without.cards.entries()].sort(),
          );
          const scope = { nowMs, tzOffsetMinutes: KST };
          expect(buildStudyQueue(withPractice, scope)).toEqual(buildStudyQueue(without, scope));
          expect(buildReviewAheadQueue(withPractice, { ...scope, days: 7 })).toEqual(
            buildReviewAheadQueue(without, { ...scope, days: 7 }),
          );
        },
      ),
      { numRuns: 80 },
    );
  });

  it('an older build keeps every new event in its snapshot, so an upgrade sees the same sets', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 30 }), (actions) => {
        const { events, nowMs } = buildLog(actions);
        const current = replayChunked(events, 5);
        // An older build: none of these types are known, so they all land in unknownEvents and
        // are serialized verbatim (the same path this build uses).
        const disguised = events.map((e) =>
          e.type === 'ReviewRecorded' ||
          e.type === 'DeckCreated' ||
          e.type === 'NoteUpserted' ||
          e.type === 'CardSuspended' ||
          e.type === 'CardUnsuspended'
            ? e
            : { ...e, type: `Legacy${e.type}` },
        );
        const snap = serializeCollectionState(replayChunked(disguised, 2));
        snap.unknownEvents = snap.unknownEvents.map((e) => ({
          ...e,
          type: e.type.replace(/^Legacy/, ''),
        }));
        expect(observe(deserializeCollectionState(snap), nowMs)).toEqual(observe(current, nowMs));
      }),
      { numRuns: 60 },
    );
  });
});
