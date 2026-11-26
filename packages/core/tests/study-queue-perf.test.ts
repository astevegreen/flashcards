import { describe, expect, it } from 'vitest';
import { buildStudyQueue } from '../src/study/queue.ts';
import {
  buildLargeCollection,
  NOW,
  REVIEW_LIMIT,
  REVIEWED_TODAY,
} from './helpers/large-collection.ts';

/**
 * P2's bound, on a collection small enough for every `pnpm test` (2k cards). The 20k-card timings
 * against the 16 ms target are a bench: `pnpm bench` (`packages/core/bench/study-queue.bench.ts`).
 */
const CARDS = 2_000;

describe('study queue on a large collection (P2)', () => {
  it('counts today from the cards reviewed today, without walking every card history', () => {
    const { state, reviews } = buildLargeCollection(CARDS, 1000);
    reviews.gets = 0;
    const result = buildStudyQueue(state, { nowMs: NOW, tzOffsetMinutes: 0 });
    // Only the 100 cards reviewed today need their history read; the 1,900 others are skipped
    // by `last_reviewed_at`. Before P2 this was two reads per card (4k).
    expect(reviews.gets).toBeLessThanOrEqual(REVIEWED_TODAY * 2);
    expect(result.counts.due).toBe(1000);
    expect(result.counts.new).toBe(0);
  });

  it('still counts the reviews done today against the daily limit when every card is due', () => {
    const { state, reviews } = buildLargeCollection(CARDS, CARDS);
    reviews.gets = 0;
    const result = buildStudyQueue(state, { nowMs: NOW, tzOffsetMinutes: 0 });
    expect(result.counts.due).toBe(Math.min(REVIEW_LIMIT, CARDS) - REVIEWED_TODAY);
    expect(reviews.gets).toBeLessThanOrEqual(REVIEWED_TODAY * 2);
  });
});
