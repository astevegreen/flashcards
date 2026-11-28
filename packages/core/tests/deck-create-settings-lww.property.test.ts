import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  replayAllEvents,
  type CollectionState,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { EventPayloadMap, FlashEvent } from '../src/events/types.ts';
import { compareHlc, createHlcState } from '../src/hlc.ts';
import { FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import { DEFAULT_DECK_SETTINGS, type DeckSettings, type NewCardOrder } from '../src/model/types.ts';

// #136 follow-up: a deterministic deck (starter, sample, Anki, inbox) can be created offline on
// several devices, and a create may carry `settings` (the Settings card order, a restore). Those
// settings must lose to every `DeckSettingsChanged` for the deck, whatever the HLCs and the merge
// order; between creates alone, the latest create wins.
const DECK = uuidv5(FLASH_NAMESPACE_UUID, 'starter-ko-core');
const T0 = Date.UTC(2026, 10, 27, 1, 0, 0);
const DEVICES = ['dev-a', 'dev-b', 'dev-c'] as const;

type Settings = Pick<DeckSettings, 'new_card_order' | 'new_cards_per_day'>;
const KEYS = ['new_card_order', 'new_cards_per_day'] as const;

function createPayload(settings?: Partial<Settings>): EventPayloadMap['DeckCreated'] {
  return {
    deck_id: DECK,
    name: 'Korean core',
    note_type_id: 'preset:vocab-ko',
    language: 'ko',
    ...(settings ? { settings } : {}),
  };
}

function shuffleWithSeed<T>(arr: readonly T[], s: number): T[] {
  const copy = [...arr];
  let x = s || 1;
  for (let i = copy.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

function replayChunked(list: readonly FlashEvent[], chunk: number): CollectionState {
  const st = createEmptyState();
  for (let i = 0; i < list.length; i += chunk) applyEvents(st, list.slice(i, i + chunk));
  return st;
}

function observe(st: CollectionState): Settings | undefined {
  const s = st.decks.get(DECK)?.settings;
  return s && { new_card_order: s.new_card_order, new_cards_per_day: s.new_cards_per_day };
}

/** The rule itself: the latest change of a key, else the latest create that sets it, else the default. */
function expected(events: readonly FlashEvent[]): Settings {
  const latest = (type: FlashEvent['type'], key: (typeof KEYS)[number]) => {
    let best: FlashEvent | undefined;
    for (const ev of events) {
      if (ev.type !== type) continue;
      const s = (ev.payload as { settings?: Partial<Settings> }).settings;
      if (s?.[key] === undefined) continue;
      if (!best || compareHlc(ev.hlc, best.hlc) > 0) best = ev;
    }
    return (best?.payload as { settings?: Partial<Settings> } | undefined)?.settings?.[key];
  };
  const out = {} as Record<(typeof KEYS)[number], unknown>;
  for (const key of KEYS) {
    out[key] =
      latest('DeckSettingsChanged', key) ??
      latest('DeckCreated', key) ??
      DEFAULT_DECK_SETTINGS[key];
  }
  return out as Settings;
}

const settingsArb = fc.record(
  {
    new_card_order: fc.constantFrom<NewCardOrder>('source', 'random'),
    new_cards_per_day: fc.integer({ min: 1, max: 50 }),
  },
  { requiredKeys: [] },
);

const actionArb = fc.record({
  kind: fc.constantFrom('create' as const, 'change' as const),
  device: fc.integer({ min: 0, max: DEVICES.length - 1 }),
  settings: settingsArb,
  withSettings: fc.boolean(),
  dt: fc.integer({ min: -5_000, max: 60_000 }),
});

describe('DeckCreated settings lose to DeckSettingsChanged (#136)', () => {
  it('the #136 case: a later offline create with an explicit order keeps the order set on another device', () => {
    const a = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
    const b = createEventFactory('dev-b', 0, createHlcState('dev-b', T0));
    const createdA = a.create('DeckCreated', createPayload(), T0 + 1_000);
    const changedA = a.create(
      'DeckSettingsChanged',
      { deck_id: DECK, settings: { new_card_order: 'random' } },
      T0 + 2_000,
    );
    // B creates the same deck offline, later, with the Settings order written in.
    const createdB = b.create(
      'DeckCreated',
      createPayload({ new_card_order: 'source' }),
      T0 + 3_000,
    );
    for (const order of [
      [createdA, changedA, createdB],
      [createdB, createdA, changedA],
      [changedA, createdB, createdA],
      [createdB, changedA, createdA],
    ]) {
      const st = createEmptyState();
      for (const ev of order) applyEvents(st, [ev]);
      expect(st.decks.get(DECK)?.settings.new_card_order).toBe('random');
    }
  });

  it('with creates alone, the latest create that sets a key wins', () => {
    const a = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
    const b = createEventFactory('dev-b', 0, createHlcState('dev-b', T0));
    const createdA = a.create('DeckCreated', createPayload({ new_card_order: 'random' }), T0);
    const createdB = b.create('DeckCreated', createPayload({ new_card_order: 'source' }), T0 + 1);
    expect(replayAllEvents([createdB, createdA]).decks.get(DECK)?.settings.new_card_order).toBe(
      'source',
    );
    expect(replayAllEvents([createdA, createdB]).decks.get(DECK)?.settings.new_card_order).toBe(
      'source',
    );
  });

  it('converges on the rule over concurrent device logs, any order, chunking, duplicates and snapshots', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 24 }),
        fc.integer({ min: 0, max: DEVICES.length - 1 }),
        fc.integer({ min: 1, max: 100_000 }),
        (actions, firstDevice, seed) => {
          // Skewed device clocks: HLC (not wall time) decides every winner.
          const factories = DEVICES.map((d, i) =>
            createEventFactory(d, 0, createHlcState(d, T0 + (i - 1) * 900)),
          );
          const f0 = factories[firstDevice] ?? factories[0];
          if (!f0) throw new Error('no factory');
          // At least one device creates the deck; changes may still arrive before any create.
          const events: FlashEvent[] = [f0.create('DeckCreated', createPayload(), T0)];
          let clock = T0;
          for (const act of actions) {
            clock += act.dt;
            const f = factories[act.device] ?? f0;
            const settings = act.withSettings ? act.settings : undefined;
            events.push(
              act.kind === 'create'
                ? f.create('DeckCreated', createPayload(settings), clock)
                : f.create(
                    'DeckSettingsChanged',
                    { deck_id: DECK, settings: settings ?? {} },
                    clock,
                  ),
            );
          }

          const want = expected(events);
          expect(observe(replayAllEvents(events))).toEqual(want);
          const orders: FlashEvent[][] = [
            [...events].reverse(),
            shuffleWithSeed(events, seed),
            [
              ...shuffleWithSeed(events, seed + 1),
              ...shuffleWithSeed(events, seed + 2).slice(0, 5),
            ],
          ];
          for (const [i, order] of orders.entries()) {
            expect(observe(replayChunked(order, i + 1))).toEqual(want);
          }

          // A snapshot of a prefix, with the rest delivered later, converges too.
          const shuffled = shuffleWithSeed(events, seed + 3);
          const cut = Math.floor(shuffled.length / 2);
          const prefix = replayChunked(shuffled.slice(0, cut), 3);
          const hydrated = deserializeCollectionState(
            JSON.parse(JSON.stringify(serializeCollectionState(prefix))) as ReturnType<
              typeof serializeCollectionState
            >,
          );
          applyEvents(hydrated, shuffled.slice(cut));
          expect(observe(hydrated)).toEqual(want);
        },
      ),
      { numRuns: 200 },
    );
  });
});
