import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type KnownEvent,
} from '../../core/src/index.ts';
import {
  buildStarterDeckEvents,
  findStarterDeck,
  loadStarterDeck,
  STARTER_SEED_EPOCH_MS,
  starterDeckId,
} from '../../core/src/starters/index.ts';
import { legacyStarterFields, loadStarterLegacyGlosses } from '../../core/src/starters/upgrade.ts';
import { runStarterDeckUpgrade } from '../src/onboarding/starterUpgrade.ts';

describe('starter-deck upgrade at launch', () => {
  it('upgrades a deck seeded from 1.1.0 once, through emitEvents', async () => {
    const slug = 'starter-zh-common';
    const info = findStarterDeck(slug);
    if (!info) throw new Error('missing deck');
    const content = await loadStarterDeck(slug);
    const legacy = await loadStarterLegacyGlosses();
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', STARTER_SEED_EPOCH_MS));
    const old = content.notes.map((n) => ({
      ...n,
      fields: legacyStarterFields(slug, n, legacy, '1.1.0') ?? n.fields,
    }));
    const state = applyEvents(
      createEmptyState(),
      buildStarterDeckEvents(factory, { ...info, version: '1.1.0' }, { slug, notes: old }),
    );

    const emitted: KnownEvent[][] = [];
    const emit = (events: KnownEvent[]) => {
      emitted.push(events);
      applyEvents(state, events);
    };
    await runStarterDeckUpgrade(() => state, { current: factory }, { current: emit });
    expect(emitted).toHaveLength(1);
    expect(state.decks.get(starterDeckId(slug))?.source?.package_version).toBe(info.version);
    for (const n of content.notes) {
      const ev = emitted[0]?.find(
        (e) => e.type === 'NoteUpserted' && e.payload.source_key === n.key,
      );
      expect(ev, n.key).toBeDefined();
    }
    for (const note of state.notes.values()) {
      const current = content.notes.find((n) => n.key === note.source_key);
      expect(note.fields).toEqual(current?.fields);
    }

    await runStarterDeckUpgrade(() => state, { current: factory }, { current: emit });
    expect(emitted).toHaveLength(1);
  });
});
