import { describe, expect, it } from 'vitest';
import { applyEvents, createEventFactory, replayAllEvents } from '../src/events/replay.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';

// D10: starter and `.flashpkg` deck ids are deterministic, so two devices can
// both emit `DeckCreated` for one deck. The result must not depend on the order
// the events arrive in.
const DECK = uuidv5(FLASH_NAMESPACE_UUID, 'starter-ko-core');
const T0 = 1_800_000_000_000;

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

function scenario(): FlashEvent[] {
  const a = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
  const b = createEventFactory('dev-b', 0, createHlcState('dev-b', T0));
  const payload = {
    deck_id: DECK,
    name: 'Korean core',
    note_type_id: 'preset:vocab-ko',
    language: 'ko',
  };
  const createdA = a.create('DeckCreated', { ...payload, created_at: T0 + 1_000 }, T0 + 1_000);
  const archivedA = a.create('DeckSettingsChanged', { deck_id: DECK, archived: true }, T0 + 2_000);
  // B installs the same starter deck offline, after A archived it.
  const createdB = b.create('DeckCreated', { ...payload, created_at: T0 + 3_000 }, T0 + 3_000);
  return [createdA, archivedA, createdB];
}

describe('duplicate DeckCreated (D10)', () => {
  it('converges on the same archived state and created_at in every delivery order', () => {
    const events = scenario();
    const results = permutations(events).map((order) => {
      // Apply one event at a time, as live sync does.
      const state = replayAllEvents([]);
      for (const event of order) applyEvents(state, [event]);
      const deck = state.decks.get(DECK);
      return { archived: deck?.archived, created_at: deck?.created_at };
    });
    for (const result of results) {
      expect(result).toEqual({ archived: true, created_at: T0 + 1_000 });
    }
  });

  it('a full replay matches the live state built in arrival order', () => {
    const [createdA, archivedA, createdB] = scenario() as [FlashEvent, FlashEvent, FlashEvent];
    // Device B: its own create first, then A's events arrive.
    const live = replayAllEvents([createdB]);
    applyEvents(live, [createdA, archivedA]);
    const full = replayAllEvents([createdA, archivedA, createdB]);
    expect(live.decks.get(DECK)).toEqual(full.decks.get(DECK));
  });

  it('an explicit unarchive after the duplicate create still wins', () => {
    const events = scenario();
    const b = createEventFactory('dev-b', 10, createHlcState('dev-b', T0 + 4_000));
    const unarchive = b.create(
      'DeckSettingsChanged',
      { deck_id: DECK, archived: false },
      T0 + 4_000,
    );
    const state = replayAllEvents([...events, unarchive]);
    expect(state.decks.get(DECK)?.archived).toBe(false);
  });
});
