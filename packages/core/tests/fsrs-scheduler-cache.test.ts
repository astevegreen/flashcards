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
const { replayAllEvents } = await import('../src/events/replay.ts');
const { buildCollection, DAY, T0 } = await import('./helpers/review-collection.ts');

// Default FSRS-6 weights with w[2] (initial stability after Good) changed.
const W = [
  0.212, 1.2931, 3.1, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614,
  0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

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

  it('stays deterministic with fuzz on: the call order of a shared scheduler never matters', () => {
    const fuzz = { request_retention: 0.9, enable_fuzz: true };
    const start = createInitialSchedule(T0);
    // Graduated schedules, where fuzz spreads the interval.
    const grown = [0, 1, 2].map((i) => {
      let schedule = start;
      for (let r = 0; r < 4 + i; r++) {
        schedule = applyReviewToSchedule(schedule, 3, T0 + (r + 1) * 5 * DAY, fuzz).next;
      }
      return schedule;
    });
    const at = T0 + 90 * DAY;
    const ratings: ReviewRating[] = [2, 3, 4];
    const inOrder = grown.map((s, i) => applyReviewToSchedule(s, ratings[i] ?? 3, at, fuzz));
    // The same inputs again, in reverse and interleaved with unrelated reviews on the shared
    // scheduler, give the same results.
    const reversed = [2, 1, 0].map((i) => {
      applyReviewToSchedule(start, 1, at - DAY, fuzz);
      const s = grown[i];
      if (!s) throw new Error('missing schedule');
      return applyReviewToSchedule(s, ratings[i] ?? 3, at, fuzz);
    });
    expect(reversed.reverse()).toEqual(inOrder);
    // Fuzz really is on for these: without it at least one interval differs.
    const plain = grown.map((s, i) =>
      applyReviewToSchedule(s, ratings[i] ?? 3, at, { request_retention: 0.9 }),
    );
    expect(plain.map((r) => r.next.due)).not.toEqual(inOrder.map((r) => r.next.due));
  });
});
