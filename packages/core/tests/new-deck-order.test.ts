import { describe, expect, it } from 'vitest';
import { newDeckCardOrder, withNewDeckCardOrder } from '../src/decks/new-deck-order.ts';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  replayAllEvents,
  type CollectionState,
} from '../src/events/replay.ts';
import type { KnownEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import type { StudyOrder } from '../src/model/types.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import { buildStarterDeckEvents, loadStarterDeck, STARTER_DECKS } from '../src/starters/index.ts';

const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);

function factoryFor(device = 'dev-a') {
  return createEventFactory(device, 0, createHlcState(device, T0));
}

/** A collection whose Settings card order is `order`, as a PreferencesChanged event leaves it. */
function stateWithOrder(order: StudyOrder | undefined): {
  state: CollectionState;
  log: KnownEvent[];
} {
  const state = createEmptyState();
  const log: KnownEvent[] = [];
  if (order) {
    const ev = factoryFor('dev-prefs').create(
      'PreferencesChanged',
      { preferences: { study_order: order } },
      T0 - 1000,
    );
    applyEvents(state, [ev]);
    log.push(ev);
  }
  return { state, log };
}

function created(events: readonly KnownEvent[]) {
  return events.flatMap((e) => (e.type === 'DeckCreated' ? [e.payload] : []));
}

function deckCreate(deckId: string, settings?: { new_card_order: 'source' | 'random' }) {
  return factoryFor().create(
    'DeckCreated',
    {
      deck_id: deckId,
      name: deckId,
      note_type_id: 'nt',
      language: 'ko',
      ...(settings && { settings }),
    },
    T0,
  );
}

describe('newDeckCardOrder', () => {
  it('maps the Settings card order to a deck new-card order, nothing when never chosen', () => {
    expect(newDeckCardOrder(stateWithOrder(undefined).state)).toBeUndefined();
    expect(newDeckCardOrder(stateWithOrder('deck').state)).toBe('source');
    expect(newDeckCardOrder(stateWithOrder('random').state)).toBe('random');
  });
});

describe('withNewDeckCardOrder', () => {
  it('returns the same events when the user never chose an order', () => {
    const events = [deckCreate('d1')];
    expect(withNewDeckCardOrder(stateWithOrder(undefined).state, events)).toBe(events);
  });

  it('writes the order into a new deck creation without mutating the event', () => {
    const { state } = stateWithOrder('random');
    const ev = deckCreate('d1');
    const [out] = withNewDeckCardOrder(state, [ev]);
    expect(out).not.toBe(ev);
    expect(ev.type === 'DeckCreated' && ev.payload.settings).toBeUndefined();
    expect(out?.type === 'DeckCreated' && out.payload.settings).toEqual({
      new_card_order: 'random',
    });
    expect(out?.id).toBe(ev.id);
    expect(out?.hlc).toBe(ev.hlc);
  });

  it('keeps other deck settings a creation carries', () => {
    const { state } = stateWithOrder('random');
    const ev = factoryFor().create(
      'DeckCreated',
      {
        deck_id: 'd1',
        name: 'd1',
        note_type_id: 'nt',
        language: 'ko',
        settings: { new_cards_per_day: 5 },
      },
      T0,
    );
    expect(created(withNewDeckCardOrder(state, [ev]))[0]?.settings).toEqual({
      new_cards_per_day: 5,
      new_card_order: 'random',
    });
  });

  it('keeps an explicit order from a package or source', () => {
    const { state } = stateWithOrder('random');
    const events = [deckCreate('d1', { new_card_order: 'source' })];
    expect(withNewDeckCardOrder(state, events)).toBe(events);
  });

  it('leaves a create for a deck that already exists, so it never resets the deck order', () => {
    const { state } = stateWithOrder('deck');
    applyEvents(state, [deckCreate('d1')]);
    applyEvents(state, [
      factoryFor().create(
        'DeckSettingsChanged',
        { deck_id: 'd1', settings: { new_card_order: 'random' } },
        T0 + 1,
      ),
    ]);
    const again = [deckCreate('d1')];
    expect(withNewDeckCardOrder(state, again)).toBe(again);
  });

  it('stays in the log: replay gives the deck its starting order after Settings changes', () => {
    const { state, log } = stateWithOrder('random');
    const events = withNewDeckCardOrder(state, [deckCreate('d1')]);
    applyEvents(state, events);
    const later = factoryFor('dev-prefs').create(
      'PreferencesChanged',
      { preferences: { study_order: 'deck' } },
      T0 + 5000,
    );
    const replayed = replayAllEvents([...log, ...events, later]);
    expect(replayed.decks.get('d1')?.settings.new_card_order).toBe('random');
    expect(replayed.preferences.study_order).toBe('deck');
  });
});

describe('every deck-creation path starts on the Settings card order', () => {
  it('sample decks', () => {
    const { state } = stateWithOrder('random');
    const events = withNewDeckCardOrder(
      state,
      buildSampleDeckEvents(factoryFor(), SAMPLE_SEED_EPOCH_MS),
    );
    const decks = created(events);
    expect(decks.length).toBeGreaterThan(1);
    for (const d of decks) expect(d.settings?.new_card_order).toBe('random');
    applyEvents(state, events);
    for (const deck of state.decks.values()) expect(deck.settings.new_card_order).toBe('random');
  });

  it('starter decks', async () => {
    const info = STARTER_DECKS[0];
    if (!info) throw new Error('no starter decks');
    const { state } = stateWithOrder('random');
    const content = await loadStarterDeck(info.slug);
    const events = withNewDeckCardOrder(state, buildStarterDeckEvents(factoryFor(), info, content));
    expect(created(events).map((d) => d.settings?.new_card_order)).toEqual(['random']);
  });

  it('.flashpkg import: a new deck takes the order, a re-import leaves the deck alone', () => {
    const authored = createEmptyState();
    applyEvents(authored, buildSampleDeckEvents(factoryFor('author'), SAMPLE_SEED_EPOCH_MS));
    const deckId = [...authored.decks.keys()][0] ?? '';
    const bytes = exportFlashpkg(authored, { deckId, packageId: 'pkg:order-test' });

    const { state } = stateWithOrder('random');
    const first = importFlashpkg(bytes, state, factoryFor(), { nowMs: T0 });
    const events = withNewDeckCardOrder(state, first.events);
    expect(created(events).map((d) => d.settings?.new_card_order)).toEqual(['random']);
    applyEvents(state, events);
    const imported = [...state.decks.values()][0];
    expect(imported?.settings.new_card_order).toBe('random');

    const second = importFlashpkg(bytes, state, factoryFor(), { nowMs: T0 + 1000 });
    expect(withNewDeckCardOrder(state, second.events)).toBe(second.events);
  });

  it('deck order in Settings writes source explicitly', () => {
    const { state } = stateWithOrder('deck');
    const events = withNewDeckCardOrder(
      state,
      buildSampleDeckEvents(factoryFor(), SAMPLE_SEED_EPOCH_MS),
    );
    for (const d of created(events)) expect(d.settings?.new_card_order).toBe('source');
  });
});
