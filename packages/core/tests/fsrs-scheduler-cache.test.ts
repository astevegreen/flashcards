import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TsFsrs from 'ts-fsrs';
import type { ReviewRating } from '../src/model/types.ts';

// Count ts-fsrs scheduler constructions (P4): replay used to build one per review.
const built = vi.hoisted(() => ({ count: 0 }));
vi.mock('ts-fsrs', async (importOriginal) => {
  const mod = await importOriginal<typeof TsFsrs>();
  return {
    ...mod,
    fsrs: (...args: Parameters<typeof mod.fsrs>) => {
      built.count += 1;
      return mod.fsrs(...args);
    },
  };
});

const { applyReviewToSchedule, createInitialSchedule, previewIntervals } =
  await import('../src/fsrs/scheduler.ts');
const { replayAllEvents, createEventFactory, replaySingleCard } =
  await import('../src/events/replay.ts');
const { createHlcState } = await import('../src/hlc.ts');
const { deriveCardId, deriveNoteId } = await import('../src/ids.ts');
const { BUILTIN_NOTE_TYPE_IDS } = await import('../src/model/presets.ts');

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 10);
// Default FSRS-6 weights with w[2] (initial stability after Good) changed.
const W = [
  0.212, 1.2931, 3.1, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614,
  0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

function buildCollection(cards: number, reviewsPerCard: number) {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
  const deckId = 'deck-p4';
  const events = [
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: 'P4',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: T0,
      },
      T0,
    ),
  ];
  const cardIds: string[] = [];
  for (let i = 0; i < cards; i++) {
    const noteId = deriveNoteId(deckId, `n${i}`);
    cardIds.push(deriveCardId(noteId, 'layout:vocab-ko:recognition', 0));
    events.push(
      factory.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: deckId,
          source_key: `n${i}`,
          fields: { word: `w${i}`, meaning: `m${i}` },
          tags: [],
        },
        T0,
      ),
    );
  }
  for (let r = 0; r < reviewsPerCard; r++) {
    const at = T0 + (r + 1) * DAY;
    cardIds.forEach((cardId, i) => {
      events.push(
        factory.create(
          'ReviewRecorded',
          {
            review_id: `rev-${i}-${r}`,
            card_id: cardId,
            rating: (((i + r) % 4) + 1) as ReviewRating,
            reviewed_at: at,
            tz_offset: 0,
            duration_ms: 1000,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: at,
          },
          at,
        ),
      );
    });
  }
  return { events, cardIds, deckId, factory };
}

describe('FSRS scheduler cache (P4)', () => {
  beforeEach(() => {
    built.count = 0;
  });

  it('builds one scheduler per distinct params, not one per replayed review', () => {
    const { events } = buildCollection(200, 10);
    replayAllEvents(events);
    // 2,000 reviews under the deck's one params set. Before P4: 2,000 constructions.
    expect(built.count).toBeLessThanOrEqual(1);
  });

  it('builds a new scheduler when the params change, and schedules with the new ones', () => {
    const schedule = createInitialSchedule(T0);
    const base = applyReviewToSchedule(schedule, 3, T0, { request_retention: 0.9 }).next;
    const sameAgain = applyReviewToSchedule(schedule, 3, T0, { request_retention: 0.9 }).next;
    expect(sameAgain).toEqual(base);

    const optimized = applyReviewToSchedule(schedule, 3, T0, { request_retention: 0.9, w: W });
    const stricter = applyReviewToSchedule(schedule, 3, T0, { request_retention: 0.97 });
    expect(optimized.next.stability).not.toBe(base.stability);
    expect(stricter.next.due).toBeLessThanOrEqual(base.due);
    const before = built.count;
    // A params edit later replays under the edited params, never a stale cached scheduler.
    const editedW = W.map((x, i) => (i === 2 ? x + 0.5 : x));
    const edited = applyReviewToSchedule(schedule, 3, T0, { request_retention: 0.9, w: editedW });
    expect(built.count).toBe(before + 1);
    expect(edited.next.stability).not.toBe(optimized.next.stability);
  });

  it('shares the cache with interval previews', () => {
    const schedule = createInitialSchedule(T0);
    previewIntervals(schedule, T0, { request_retention: 0.85 });
    previewIntervals(schedule, T0 + DAY, { request_retention: 0.85 });
    applyReviewToSchedule(schedule, 2, T0, { request_retention: 0.85 });
    expect(built.count).toBeLessThanOrEqual(1);
  });

  it('reports replay timings for 20k reviews', () => {
    const { events, cardIds } = buildCollection(2000, 10);
    const t0 = performance.now();
    const state = replayAllEvents(events);
    const full = performance.now() - t0;
    const t1 = performance.now();
    for (const id of cardIds) replaySingleCard(state, id);
    const single = performance.now() - t1;
    console.info(
      `[P4] replayAllEvents, 20k reviews: ${full.toFixed(0)} ms; replaySingleCard x2000: ${single.toFixed(0)} ms`,
    );
    expect(state.cards.size).toBe(2000);
  });
});
