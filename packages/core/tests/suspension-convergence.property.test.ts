import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  isCardSuspended,
  type CollectionState,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import { listSuspendedCardIds } from '../src/events/suspension.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import type { ReviewRating } from '../src/model/types.ts';
import { filterCards } from '../src/study/filter.ts';
import { normalizeCardFilter } from '../src/study/filter-normalize.ts';
import { buildStudyQueue } from '../src/study/queue.ts';

const DECK = 'deck-ko-suspend-prop';
const LAYOUT = 'layout:vocab-ko:recognition';
const NOTE_KEYS = ['학교', '도서관', '약속'];
const cardIdFor = (i: number) => deriveCardId(deriveNoteId(DECK, NOTE_KEYS[i] ?? ''), LAYOUT, 0);

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

function observe(st: CollectionState, nowMs: number) {
  const ctx = { nowMs, tzOffsetMinutes: 540 };
  const suspended = NOTE_KEYS.map((_, i) => isCardSuspended(st, cardIdFor(i)));
  // The one-pass register scan the study queue uses (P2) agrees with the per-card check.
  expect([...listSuspendedCardIds(st.fieldHlcs)].sort()).toEqual(
    NOTE_KEYS.map((_, i) => cardIdFor(i))
      .filter((_, i) => suspended[i])
      .sort(),
  );
  return {
    suspended,
    queue: buildStudyQueue(st, { ...ctx, deckId: DECK }).queue.map((c) => c.id),
    suspendedFilter: filterCards(st, { states: ['suspended'] }, ctx).map((c) => c.id),
    trouble: filterCards(
      st,
      normalizeCardFilter({ deckIds: [DECK], performance: { minAgainCount: 1, hardest: 2 } }),
      ctx,
    ).map((c) => c.id),
    schedules: NOTE_KEYS.map((_, i) => st.cards.get(cardIdFor(i))?.schedule),
  };
}

describe('CardSuspended / CardUnsuspended convergence (fast-check)', () => {
  const actionArb = fc.oneof(
    fc.record({
      kind: fc.constantFrom('suspend' as const, 'unsuspend' as const),
      device: fc.integer({ min: 0, max: 2 }),
      card: fc.integer({ min: 0, max: 2 }),
      dt: fc.integer({ min: -5_000, max: 60_000 }),
    }),
    fc.record({
      kind: fc.constant('review' as const),
      device: fc.integer({ min: 0, max: 2 }),
      card: fc.integer({ min: 0, max: 2 }),
      rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4),
      dt: fc.integer({ min: 1, max: 400_000 }),
    }),
    fc.record({
      kind: fc.constant('edit' as const),
      device: fc.integer({ min: 0, max: 2 }),
      card: fc.integer({ min: 0, max: 2 }),
      value: fc.string({ minLength: 1, maxLength: 6 }),
      dt: fc.integer({ min: 1, max: 50_000 }),
    }),
  );

  it('converges under any interleaving, chunking, duplicates and snapshot hydration', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 3, maxLength: 40 }),
        fc.integer({ min: 1, max: 100_000 }),
        (actions, seed) => {
          const base = Date.UTC(2026, 2, 1, 1, 0, 0);
          // Skewed device clocks: HLC (not wall time) decides the winner.
          const factories = [
            createEventFactory('dev-a', 0, createHlcState('dev-a', base)),
            createEventFactory('dev-b', 0, createHlcState('dev-b', base + 700)),
            createEventFactory('dev-c', 0, createHlcState('dev-c', base - 900)),
          ] as const;
          const [f0] = factories;
          const events: FlashEvent[] = [
            f0.create(
              'DeckCreated',
              {
                deck_id: DECK,
                name: '한국어',
                note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
                language: 'ko',
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
                  tags: ['topik-1'],
                  created_order: i,
                },
                base + i + 1,
              ),
            );
          });

          let clock = base + 1000;
          let n = 0;
          for (const act of actions) {
            clock += act.dt;
            const f = factories[act.device] ?? f0;
            if (act.kind === 'suspend' || act.kind === 'unsuspend') {
              events.push(
                f.create(
                  act.kind === 'suspend' ? 'CardSuspended' : 'CardUnsuspended',
                  { card_id: cardIdFor(act.card) },
                  clock,
                ),
              );
            } else if (act.kind === 'review') {
              n += 1;
              events.push(
                f.create(
                  'ReviewRecorded',
                  {
                    review_id: `r-${n}-${act.device}`,
                    card_id: cardIdFor(act.card),
                    rating: act.rating,
                    reviewed_at: clock,
                    tz_offset: 540,
                    duration_ms: 1000,
                    answer_mode: 'flip',
                    fsrs_params_version: 0,
                    resulting_due_at: clock,
                  },
                  clock,
                ),
              );
            } else if (act.kind === 'edit') {
              const key = NOTE_KEYS[act.card] ?? '';
              events.push(
                f.create(
                  'NoteUpserted',
                  {
                    note_id: deriveNoteId(DECK, key),
                    deck_id: DECK,
                    source_key: key,
                    fields: { notes: act.value },
                  },
                  clock,
                ),
              );
            }
          }

          const nowMs = clock + 2 * 86_400_000;
          const reference = observe(replayChunked(events, events.length), nowMs);

          const orders: FlashEvent[][] = [
            [...events].reverse(),
            shuffleWithSeed(events, seed),
            [
              ...shuffleWithSeed(events, seed + 1),
              ...shuffleWithSeed(events, seed + 2).slice(0, 7),
            ],
          ];
          for (const [i, order] of orders.entries()) {
            expect(observe(replayChunked(order, i + 1), nowMs)).toEqual(reference);
          }

          // Snapshot of a prefix + the rest delivered later converges too.
          const cut = Math.floor(events.length / 2);
          const shuffled = shuffleWithSeed(events, seed + 3);
          const prefixState = replayChunked(shuffled.slice(0, cut), 4);
          const hydrated = deserializeCollectionState(
            JSON.parse(JSON.stringify(serializeCollectionState(prefixState))) as ReturnType<
              typeof serializeCollectionState
            >,
          );
          applyEvents(hydrated, shuffled.slice(cut));
          expect(observe(hydrated, nowMs)).toEqual(reference);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('an older build (types unknown) never crashes and preserves the events for upgrade', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            on: fc.boolean(),
            card: fc.integer({ min: 0, max: 2 }),
            device: fc.integer({ min: 0, max: 1 }),
            dt: fc.integer({ min: -2_000, max: 30_000 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        (ops) => {
          const base = Date.UTC(2026, 2, 1, 1, 0, 0);
          const factories = [
            createEventFactory('dev-a', 0, createHlcState('dev-a', base)),
            createEventFactory('dev-b', 0, createHlcState('dev-b', base + 300)),
          ] as const;
          let clock = base;
          const events = ops.map((op) => {
            clock += op.dt;
            return (factories[op.device] ?? factories[0]).create(
              op.on ? 'CardSuspended' : 'CardUnsuspended',
              { card_id: cardIdFor(op.card) },
              clock,
            );
          });
          const current = replayChunked(events, 3);

          // Simulate an old build: rename the types so this build does not recognise them, then
          // restore the names in the serialized snapshot as the old build would have kept them.
          const disguised = events.map((e) => ({ ...e, type: `Legacy${e.type}` }));
          const old = replayChunked(disguised, 2);
          expect(old.unknownEvents).toHaveLength(events.length);
          const snap = serializeCollectionState(old);
          snap.unknownEvents = snap.unknownEvents.map((e) => ({
            ...e,
            type: e.type.replace(/^Legacy/, ''),
          }));
          const upgraded = deserializeCollectionState(snap);
          for (let i = 0; i < NOTE_KEYS.length; i++) {
            expect(isCardSuspended(upgraded, cardIdFor(i))).toBe(
              isCardSuspended(current, cardIdFor(i)),
            );
          }
          expect(upgraded.unknownEvents).toHaveLength(0);
        },
      ),
      { numRuns: 60 },
    );
  });
});
