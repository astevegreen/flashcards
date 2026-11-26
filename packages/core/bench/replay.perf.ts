import { describe, expect, it } from 'vitest';
import { replayAllEvents, replaySingleCard } from '../src/events/replay.ts';
import { buildCollection } from '../tests/helpers/review-collection.ts';
import { medianMs } from './median.ts';

/** P4 timings: 20k reviews over 2,000 cards. */
describe('replay, 20k reviews (P4)', () => {
  it('replayAllEvents and replaySingleCard', () => {
    const { events, cardIds } = buildCollection(2000, 10);
    const state = replayAllEvents(events);
    const full = medianMs(() => replayAllEvents(events), 5);
    const single = medianMs(() => {
      for (const id of cardIds) replaySingleCard(state, id);
    }, 5);
    console.info(
      `[P4] replayAllEvents, 20k reviews: median ${full.toFixed(0)} ms; replaySingleCard x2000: median ${single.toFixed(0)} ms`,
    );
    expect(state.cards.size).toBe(2000);
  });
});
