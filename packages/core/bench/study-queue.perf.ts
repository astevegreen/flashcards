import { describe, expect, it } from 'vitest';
import { buildStudyQueue } from '../src/study/queue.ts';
import { buildLargeCollection, NOW } from '../tests/helpers/large-collection.ts';
import { medianMs } from './median.ts';

/** P2 timings on 20k cards (target: one build well under a 16 ms frame). */
const CARDS = 20_000;

describe('buildStudyQueue, 20k cards (P2)', () => {
  for (const [label, dueToday] of [
    ['1,000 due', 1000],
    ['every card due', CARDS],
  ] as const) {
    it(label, () => {
      const { state } = buildLargeCollection(CARDS, dueToday);
      const ms = medianMs(() => buildStudyQueue(state, { nowMs: NOW, tzOffsetMinutes: 0 }));
      console.info(`[P2] buildStudyQueue, ${CARDS} cards, ${label}: median ${ms.toFixed(2)} ms`);
      expect(ms).toBeGreaterThan(0);
    });
  }
});
