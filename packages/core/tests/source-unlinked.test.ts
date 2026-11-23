import { describe, expect, it } from 'vitest';
import { computeStatePatch, mergeStatePatch } from '../src/events/patch.ts';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  replayAllEvents,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import { isKnownEventType, type FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';

const t0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const deckId = 'deck-od';
const pageId = 'page-gdoc';
const odSource = { kind: 'onedrive_file' as const, external_id: 'item-1', read_only: true };

function scenario() {
  const fA = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
  const fB = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 500));
  const created = fA.create(
    'DeckCreated',
    {
      deck_id: deckId,
      name: 'Words',
      note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
      source: odSource,
      created_at: t0,
    },
    t0,
  );
  const note = fA.create(
    'NoteUpserted',
    { note_id: 'note-1', deck_id: deckId, source_key: '강', fields: { word: '강' } },
    t0 + 10,
  );
  const refreshed = fA.create(
    'SourceLinked',
    {
      target_kind: 'deck',
      target_id: deckId,
      source: { ...odSource, content_hash: 'abc', last_synced_at: t0 + 100 },
    },
    t0 + 100,
  );
  const unlinked = fB.create(
    'SourceUnlinked',
    { target_kind: 'deck', target_id: deckId },
    t0 + 200,
  );
  const page = fA.create(
    'PageUpserted',
    {
      page_id: pageId,
      slug: 'notes',
      title: 'Notes',
      markdown: '# Notes',
      source: { kind: 'google_docs', external_id: 'doc-1' },
    },
    t0 + 20,
  );
  const pageUnlinked = fB.create(
    'SourceUnlinked',
    { target_kind: 'page', target_id: pageId },
    t0 + 300,
  );
  return { fA, fB, created, note, refreshed, unlinked, page, pageUnlinked };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('SourceUnlinked', () => {
  it('is a known event type', () => {
    expect(isKnownEventType('SourceUnlinked')).toBe(true);
  });

  it('clears the deck source and keeps its notes', () => {
    const s = scenario();
    const state = replayAllEvents([s.created, s.note, s.refreshed, s.unlinked]);
    const deck = state.decks.get(deckId);
    expect(deck).toBeDefined();
    expect(deck?.source).toBeUndefined();
    expect(state.notes.get('note-1')?.archived).toBe(false);
  });

  it('converges in every delivery order, with an older link arriving late staying out', () => {
    const s = scenario();
    const events: FlashEvent[] = [s.created, s.refreshed, s.unlinked, s.page, s.pageUnlinked];
    const expected = serializeCollectionState(replayAllEvents(events));
    expect(expected.decks.find((d) => d.id === deckId)?.source).toBeUndefined();
    expect(expected.pages.find((p) => p.id === pageId)?.source).toBeUndefined();
    for (const order of permutations(events)) {
      // One event per batch, so every order also exercises the pending (pre-create) path.
      const state = createEmptyState();
      for (const ev of order) applyEvents(state, [ev]);
      expect(serializeCollectionState(state)).toEqual(expected);
    }
  });

  it('loses to a newer relink, in any order', () => {
    const s = scenario();
    const relinked = s.fA.create(
      'SourceLinked',
      { target_kind: 'deck', target_id: deckId, source: { ...odSource, content_hash: 'new' } },
      t0 + 5_000,
    );
    const events: FlashEvent[] = [s.created, s.unlinked, relinked];
    for (const order of permutations(events)) {
      const state = createEmptyState();
      for (const ev of order) applyEvents(state, [ev]);
      expect(state.decks.get(deckId)?.source?.content_hash).toBe('new');
    }
  });

  it('reaches the main thread through a worker patch', () => {
    const s = scenario();
    const worker = replayAllEvents([s.created, s.refreshed]);
    const main = replayAllEvents([s.created, s.refreshed]);
    mergeStatePatch(main, computeStatePatch(worker, [s.unlinked]));
    expect(main.decks.get(deckId)?.source).toBeUndefined();
    expect(main.decks.get(deckId)?.name).toBe('Words');
  });

  it('survives a snapshot round trip', () => {
    const s = scenario();
    const state = replayAllEvents([s.created, s.refreshed, s.unlinked]);
    const hydrated = deserializeCollectionState(serializeCollectionState(state));
    expect(hydrated.decks.get(deckId)?.source).toBeUndefined();
    // A link older than the unlink, delivered after hydration, stays out.
    applyEvents(hydrated, [s.refreshed]);
    expect(hydrated.decks.get(deckId)?.source).toBeUndefined();
  });

  it('folds an unlink an older build kept as unknown when hydrating its snapshot', () => {
    const s = scenario();
    // What an older build's snapshot looks like: the unlink sits untouched in unknownEvents.
    const old = serializeCollectionState(replayAllEvents([s.created, s.refreshed]));
    old.unknownEvents.push(JSON.parse(JSON.stringify(s.unlinked)) as typeof s.unlinked);
    old.totalEvents += 1;
    const hydrated = deserializeCollectionState(old);
    expect(hydrated.decks.get(deckId)?.source).toBeUndefined();
    expect(hydrated.unknownEvents).toEqual([]);
    expect(serializeCollectionState(hydrated)).toEqual(
      serializeCollectionState(replayAllEvents([s.created, s.refreshed, s.unlinked])),
    );
  });

  it('ignores a malformed payload', () => {
    const s = scenario();
    const state = replayAllEvents([s.created]);
    const bad = { ...s.unlinked, payload: { target_kind: 'card', target_id: deckId } };
    applyEvents(state, [bad as FlashEvent]);
    expect(state.decks.get(deckId)?.source).toEqual(odSource);
  });
});
