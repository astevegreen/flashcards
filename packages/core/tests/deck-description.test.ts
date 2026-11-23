import { describe, expect, it } from 'vitest';
import {
  DECK_DESCRIPTION_MAX_LENGTH,
  getDeckDescription,
  normalizeDeckDescription,
} from '../src/decks/description.ts';
import { applyEvents, createEventFactory, replayAllEvents } from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import { isKnownEventType, type FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import {
  buildStarterDeckEvents,
  findStarterDeck,
  loadStarterDeck,
  STARTER_SEED_EPOCH_MS,
  starterDeckId,
} from '../src/starters/index.ts';

const T0 = Date.UTC(2026, 10, 1);
const DECK = 'deck-1';

function deckEvents(device = 'dev-a') {
  const factory = createEventFactory(device, 0, createHlcState(device, T0));
  const events: FlashEvent[] = [
    factory.create(
      'DeckCreated',
      { deck_id: DECK, name: 'Travel', note_type_id: 'preset:vocab-ko', language: 'ko' },
      T0,
    ),
    factory.create(
      'NoteUpserted',
      {
        note_id: 'n1',
        deck_id: DECK,
        source_key: 'k1',
        fields: { word: '공항', meaning: 'airport' },
      },
      T0,
    ),
  ];
  return { factory, events };
}

describe('normalizeDeckDescription', () => {
  it('keeps plain text and line breaks, drops control characters, caps the length', () => {
    expect(normalizeDeckDescription('  Words for the airport.\r\nTwo  lines.  ')).toBe(
      'Words for the airport.\nTwo  lines.',
    );
    expect(normalizeDeckDescription('a\u0000b\u0007c\td')).toBe('abc\td');
    expect(normalizeDeckDescription('one\n\n\n\ntwo')).toBe('one\n\ntwo');
    expect(normalizeDeckDescription('one \n  \n\t\n\ntwo\rthree')).toBe('one\n\ntwo\nthree');
    // Long runs of spaces without a line break stay linear (no regex backtracking).
    expect(normalizeDeckDescription(`a${' '.repeat(200_000)}b`)).toBe('a');
    expect(normalizeDeckDescription('<b>not html</b>')).toBe('<b>not html</b>');
    expect(normalizeDeckDescription(42)).toBe('');
    expect(normalizeDeckDescription('x'.repeat(5000))).toHaveLength(DECK_DESCRIPTION_MAX_LENGTH);
  });
});

describe('deck description events', () => {
  it('are log-retained and resolve by last-writer-wins under any order', () => {
    expect(isKnownEventType('DeckDescriptionChanged')).toBe(false);
    const a = deckEvents('dev-a');
    const b = createEventFactory('dev-b', 0, createHlcState('dev-b', T0));
    const first = a.factory.create(
      'DeckDescriptionChanged',
      { deck_id: DECK, description: 'First' },
      T0 + 1,
    );
    const second = b.create(
      'DeckDescriptionChanged',
      { deck_id: DECK, description: 'Second' },
      T0 + 2,
    );
    expect(getDeckDescription(replayAllEvents([...a.events, first, second]), DECK)).toBe('Second');
    expect(getDeckDescription(replayAllEvents([second, ...a.events, first]), DECK)).toBe('Second');

    const cleared = a.factory.create(
      'DeckDescriptionChanged',
      { deck_id: DECK, description: '' },
      T0 + 3,
    );
    const state = replayAllEvents([...a.events, first, second, cleared]);
    expect(getDeckDescription(state, DECK)).toBe('');
  });

  it('survive a snapshot round trip and refresh when events arrive', () => {
    const { factory, events } = deckEvents();
    const state = replayAllEvents(events);
    expect(getDeckDescription(state, DECK)).toBe('');
    applyEvents(state, [
      factory.create('DeckDescriptionChanged', { deck_id: DECK, description: 'Hi' }, T0 + 1),
    ]);
    expect(getDeckDescription(state, DECK)).toBe('Hi');
    const restored = deserializeCollectionState(serializeCollectionState(state));
    expect(getDeckDescription(restored, DECK)).toBe('Hi');
  });
});

describe('description sources', () => {
  it('travels in a .flashpkg and never replaces a description the user already has', () => {
    const { factory, events } = deckEvents();
    events.push(
      factory.create(
        'DeckDescriptionChanged',
        { deck_id: DECK, description: 'Airport words.\nLevel 1.' },
        T0 + 1,
      ),
    );
    const pkg = exportFlashpkg(replayAllEvents(events), { packageId: 'pkg:travel' });

    const factoryB = createEventFactory('dev-b', 0, createHlcState('dev-b', T0 + 10));
    const stateB = replayAllEvents([]);
    const imported = importFlashpkg(pkg, stateB, factoryB, { nowMs: T0 + 10 });
    applyEvents(stateB, imported.events);
    const deckId = [...stateB.decks.keys()][0] ?? '';
    expect(getDeckDescription(stateB, deckId)).toBe('Airport words.\nLevel 1.');

    applyEvents(stateB, [
      factoryB.create('DeckDescriptionChanged', { deck_id: deckId, description: 'Mine' }, T0 + 20),
    ]);
    const again = importFlashpkg(pkg, stateB, factoryB, { nowMs: T0 + 30 });
    expect(again.events.some((e) => e.type === 'DeckDescriptionChanged')).toBe(false);
    applyEvents(stateB, again.events);
    expect(getDeckDescription(stateB, deckId)).toBe('Mine');
  });

  it('comes from the starter catalog for starter decks', async () => {
    const info = findStarterDeck('starter-ko-core');
    if (!info) throw new Error('missing starter deck');
    expect(info.description.length).toBeGreaterThan(0);
    const content = await loadStarterDeck(info.slug);
    const factory = createEventFactory('dev-s', 0, createHlcState('dev-s', STARTER_SEED_EPOCH_MS));
    const state = replayAllEvents(buildStarterDeckEvents(factory, info, content));
    expect(getDeckDescription(state, starterDeckId(info.slug))).toBe(info.description);
  });
});
