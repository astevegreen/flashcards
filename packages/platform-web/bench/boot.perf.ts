import 'fake-indexeddb/auto';
import {
  applyEvents,
  applyEventsWithDiff,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveCardId,
  deriveNoteId,
  deserializeCollectionState,
  serializeCollectionState,
  type FlashEvent,
  type ReviewRating,
} from '@flash/core';
import Dexie from 'dexie';
import { afterAll, describe, expect, it } from 'vitest';
import { DexieStorage } from '../src/storage/dexie-storage.ts';

/**
 * P5 timings: a cold boot as `apps/web/src/main.tsx` does it, from Dexie to a ready
 * `CollectionState`, on 50k reviews over 5,000 cards in 5 decks (10 reviews per card, a day apart).
 * IndexedDB here is fake-indexeddb, so the storage reads are a stand-in for a browser's.
 */
const DECKS = 5;
const CARDS_PER_DECK = 1000;
const REVIEWS_PER_CARD = 10;
const DELTA = 200;
const ROUNDS = 7;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 10);

function buildEvents(): FlashEvent[] {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
  const events: FlashEvent[] = [];
  const cardIds: string[] = [];
  for (let d = 0; d < DECKS; d++) {
    const deckId = `deck-p5-${d}`;
    events.push(
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: `P5 ${d}`,
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: T0,
        },
        T0,
      ),
    );
    for (let i = 0; i < CARDS_PER_DECK; i++) {
      const noteId = deriveNoteId(deckId, `n${i}`);
      cardIds.push(deriveCardId(noteId, 'layout:vocab-ko:recognition', 0));
      events.push(
        factory.create(
          'NoteUpserted',
          {
            note_id: noteId,
            deck_id: deckId,
            source_key: `n${i}`,
            fields: { word: `w${d}-${i}`, meaning: `meaning ${d}-${i}` },
            tags: [],
          },
          T0,
        ),
      );
    }
  }
  for (let r = 0; r < REVIEWS_PER_CARD; r++) {
    const at = T0 + (r + 1) * DAY;
    cardIds.forEach((cardId, i) => {
      events.push(
        factory.create(
          'ReviewRecorded',
          {
            review_id: `rev-${i}-${r}`,
            card_id: cardId,
            rating: (((i + r) % 4) + 1) as ReviewRating,
            reviewed_at: at + i,
            tz_offset: 0,
            duration_ms: 1000,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: at,
          },
          at + i,
        ),
      );
    });
  }
  return events;
}

async function medianAsync(run: () => Promise<void>, rounds = ROUNDS): Promise<number> {
  await run();
  const times: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? 0;
}

const storages: DexieStorage[] = [];
afterAll(async () => {
  for (const s of storages) await Dexie.delete(s.dbName);
});

describe('cold boot, 50k reviews over 5,000 cards (P5)', () => {
  it('full replay, snapshot plus delta', async () => {
    const events = buildEvents();
    const reviews = events.filter((e) => e.type === 'ReviewRecorded').length;
    expect(reviews).toBe(DECKS * CARDS_PER_DECK * REVIEWS_PER_CARD);

    const storage = new DexieStorage(`bench-p5-${Date.now()}`);
    storages.push(storage);
    const head = events.slice(0, events.length - DELTA);
    await storage.appendEvents(head);

    // No snapshot (first boot after install, an import, or a snapshot dropped by a rebuild).
    let state = createEmptyState();
    const read = await medianAsync(async () => {
      await storage.getAllEvents();
    });
    const replay = await medianAsync(async () => {
      state = applyEvents(createEmptyState(), head);
    });
    const fullBoot = await medianAsync(async () => {
      state = applyEvents(createEmptyState(), await storage.getAllEvents());
    });
    expect(state.cards.size).toBe(DECKS * CARDS_PER_DECK);

    // The usual boot: snapshot plus the events appended after it.
    const localSeq = await storage.getMaxLocalSeq();
    await storage.setLocalSnapshot({
      snapshot: serializeCollectionState(state, { 'dev-a': head.length }),
      localSeq,
      savedAt: Date.now(),
    });
    await storage.appendEvents(events.slice(events.length - DELTA));
    const snapshotBoot = await medianAsync(async () => {
      const snap = await storage.getLocalSnapshot();
      if (!snap) throw new Error('no snapshot');
      const s = deserializeCollectionState(snap.snapshot);
      const delta = await storage.getEventsAfterLocalSeq(snap.localSeq);
      applyEventsWithDiff(s, delta.events);
      state = s;
    });
    expect(state.cards.size).toBe(DECKS * CARDS_PER_DECK);

    console.info(
      [
        `[P5] ${events.length} events (${reviews} reviews, ${state.cards.size} cards, ${DECKS} decks), median of ${ROUNDS}:`,
        `  full boot, no snapshot (getAllEvents + applyEvents): ${fullBoot.toFixed(0)} ms`,
        `    of which getAllEvents (fake-indexeddb): ${read.toFixed(0)} ms, applyEvents: ${replay.toFixed(0)} ms`,
        `  snapshot boot (getLocalSnapshot + deserialize + ${DELTA}-event delta): ${snapshotBoot.toFixed(0)} ms`,
      ].join('\n'),
    );
  });
});
