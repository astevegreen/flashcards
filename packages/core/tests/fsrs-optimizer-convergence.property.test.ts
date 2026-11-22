import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  type CollectionState,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import type { ReviewRating } from '../src/model/types.ts';
import {
  buildOptimizedParamsPayload,
  collectOptimizerDataset,
  getCurrentDeckWeights,
  normalizeOptimizedWeights,
} from '../src/optimizer/fsrs-optimizer.ts';

const DECK = 'deck-ko-optimizer-prop';
const LAYOUT = 'layout:vocab-ko:recognition';
const NOTE_KEYS = ['학교', '도서관', '약속'];
const cardIdFor = (i: number) => deriveCardId(deriveNoteId(DECK, NOTE_KEYS[i] ?? ''), LAYOUT, 0);
const DAY = 86_400_000;
const DEFAULT_W = getCurrentDeckWeights(createEmptyState(), DECK, 0);

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

/** Everything replay derives that the optimizer touches. */
function observe(st: CollectionState, nowMs: number) {
  return {
    schedules: NOTE_KEYS.map((_, i) => st.cards.get(cardIdFor(i))?.schedule),
    params: st.deckFsrsParams.get(DECK) ?? [],
    weightsNow: getCurrentDeckWeights(st, DECK, nowMs),
    dataset: collectOptimizerDataset(st, DECK),
    nextPayload: buildOptimizedParamsPayload(st, DECK, DEFAULT_W, {
      nowMs,
      rescheduleExisting: true,
    }),
  };
}

const weightsArb = fc
  .array(fc.double({ min: 0.5, max: 1.6, noNaN: true }), {
    minLength: DEFAULT_W.length,
    maxLength: DEFAULT_W.length,
  })
  .map((scales) => normalizeOptimizedWeights(DEFAULT_W.map((w, i) => w * (scales[i] ?? 1))));

const actionArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('review' as const),
      device: fc.integer({ min: 0, max: 2 }),
      card: fc.integer({ min: 0, max: 2 }),
      rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4),
      // Reviews may be recorded under a params version this device has not seen yet.
      version: fc.integer({ min: 0, max: 3 }),
      dt: fc.integer({ min: 60_000, max: 9 * DAY }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('optimize' as const),
      device: fc.integer({ min: 0, max: 2 }),
      // Concurrent optimizer runs on two devices can pick the same version: LWW decides.
      version: fc.integer({ min: 1, max: 3 }),
      reschedule: fc.boolean(),
      weights: weightsArb,
      dt: fc.integer({ min: 1_000, max: 3 * DAY }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('undo' as const),
      device: fc.integer({ min: 0, max: 2 }),
      dt: fc.integer({ min: 1_000, max: 60_000 }),
    }),
  },
);

describe('Optimized DeckFSRSParamsChanged + reschedule convergence (fast-check)', () => {
  it('replays to identical schedules, params and optimizer datasets in any delivery order', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 3, maxLength: 36 }),
        fc.integer({ min: 1, max: 100_000 }),
        (actions, seed) => {
          const base = Date.UTC(2026, 2, 1, 1, 0, 0);
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
                  created_order: i,
                },
                base + i + 1,
              ),
            );
          });

          let clock = base + 1000;
          let n = 0;
          let lastReviewId: string | undefined;
          for (const act of actions) {
            clock += act.dt;
            const f = factories[act.device] ?? f0;
            if (act.kind === 'review') {
              n += 1;
              lastReviewId = `r-${n}-${act.device}`;
              events.push(
                f.create(
                  'ReviewRecorded',
                  {
                    review_id: lastReviewId,
                    card_id: cardIdFor(act.card),
                    rating: act.rating,
                    reviewed_at: clock,
                    tz_offset: 540,
                    duration_ms: 1000,
                    answer_mode: 'flip',
                    fsrs_params_version: act.version,
                    resulting_due_at: clock,
                  },
                  clock,
                ),
              );
            } else if (act.kind === 'undo') {
              if (lastReviewId) {
                events.push(f.create('ReviewUndone', { review_id: lastReviewId }, clock));
              }
            } else if (act.weights) {
              events.push(
                f.create(
                  'DeckFSRSParamsChanged',
                  {
                    deck_id: DECK,
                    params_version: act.version,
                    effective_from: clock,
                    params: { request_retention: 0.9, w: act.weights },
                    ...(act.reschedule ? { reschedule_existing: true } : {}),
                  },
                  clock,
                ),
              );
            }
          }

          const nowMs = clock + 2 * DAY;
          const reference = observe(replayChunked(events, events.length), nowMs);

          const orders: FlashEvent[][] = [
            [...events].reverse(),
            shuffleWithSeed(events, seed),
            // Duplicate delivery of a random subset.
            [
              ...shuffleWithSeed(events, seed + 1),
              ...shuffleWithSeed(events, seed + 2).slice(0, 9),
            ],
          ];
          for (const [i, order] of orders.entries()) {
            expect(observe(replayChunked(order, i + 1), nowMs)).toEqual(reference);
          }

          // A snapshot of a shuffled prefix with the rest delivered later converges too.
          const cut = Math.floor(events.length / 2);
          const shuffled = shuffleWithSeed(events, seed + 3);
          const prefix = replayChunked(shuffled.slice(0, cut), 4);
          const hydrated = deserializeCollectionState(
            JSON.parse(JSON.stringify(serializeCollectionState(prefix))) as ReturnType<
              typeof serializeCollectionState
            >,
          );
          applyEvents(hydrated, shuffled.slice(cut));
          expect(observe(hydrated, nowMs)).toEqual(reference);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('applying an optimizer result twice (re-delivery) is idempotent', () => {
    fc.assert(
      fc.property(weightsArb, fc.boolean(), (weights, reschedule) => {
        if (!weights) return;
        const base = Date.UTC(2026, 4, 1);
        const f = createEventFactory('dev-a', 0, createHlcState('dev-a', base));
        const events: FlashEvent[] = [
          f.create(
            'DeckCreated',
            {
              deck_id: DECK,
              name: 'd',
              note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
              language: 'ko',
            },
            base,
          ),
          f.create(
            'NoteUpserted',
            {
              note_id: deriveNoteId(DECK, NOTE_KEYS[0] ?? ''),
              deck_id: DECK,
              source_key: NOTE_KEYS[0] ?? '',
              fields: { word: 'w', meaning: 'm' },
            },
            base + 1,
          ),
          ...[0, 1, 4, 11].map((d, i) =>
            f.create(
              'ReviewRecorded',
              {
                review_id: `r${i}`,
                card_id: cardIdFor(0),
                rating: i === 2 ? 1 : 3,
                reviewed_at: base + d * DAY + 3_600_000,
                tz_offset: 0,
                duration_ms: 500,
                answer_mode: 'flip',
                fsrs_params_version: 0,
                resulting_due_at: 0,
              },
              base + d * DAY + 3_600_000,
            ),
          ),
        ];
        const state = replayChunked(events, events.length);
        const nowMs = base + 20 * DAY;
        const payload = buildOptimizedParamsPayload(state, DECK, weights, {
          nowMs,
          rescheduleExisting: reschedule,
        });
        const ev = f.create('DeckFSRSParamsChanged', payload, nowMs);
        applyEvents(state, [ev]);
        const once = observe(state, nowMs);
        applyEvents(state, [ev]);
        expect(observe(state, nowMs)).toEqual(once);
        expect(once.weightsNow).toEqual(weights);
      }),
      { numRuns: 40 },
    );
  });
});
