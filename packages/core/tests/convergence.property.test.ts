import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  type CollectionState,
} from '../src/events/replay.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import type { ReviewRating } from '../src/model/types.ts';

function canonicalSnapshot(state: CollectionState) {
  const decks = [...state.decks.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => ({ id: d.id, name: d.name, settings: d.settings, archived: d.archived }));

  const notes = [...state.notes.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      deck_id: n.deck_id,
      fields: Object.fromEntries(Object.entries(n.fields).sort(([a], [b]) => a.localeCompare(b))),
      tags: n.tags,
      archived: n.archived,
    }));

  const cards = [...state.cards.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      note_id: c.note_id,
      layout_id: c.layout_id,
      schedule: c.schedule,
      last_reviewed_at: c.last_reviewed_at,
    }));

  return { decks, notes, cards, preferences: state.preferences };
}

describe('Multi-device CRDT/event-log convergence (fast-check property test)', () => {
  it('converges to identical decks, notes, cards, and FSRS schedules under arbitrary event interleaving & duplicates', () => {
    const deckId = 'deck-prop-1';
    const noteKeys = ['n1', 'n2', 'n3'];
    const layoutId = 'layout:vocab-ko:recognition';

    const actionArb = fc.oneof(
      fc.record({
        kind: fc.constant('editField' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        noteIdx: fc.integer({ min: 0, max: 2 }),
        field: fc.constantFrom('word', 'meaning', 'notes'),
        value: fc.string({ minLength: 1, maxLength: 12 }),
        dt: fc.integer({ min: 1, max: 50_000 }),
      }),
      fc.record({
        kind: fc.constant('archiveToggle' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        noteIdx: fc.integer({ min: 0, max: 2 }),
        archive: fc.boolean(),
        dt: fc.integer({ min: 1, max: 50_000 }),
      }),
      fc.record({
        kind: fc.constant('review' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        noteIdx: fc.integer({ min: 0, max: 2 }),
        rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4),
        dt: fc.integer({ min: 1, max: 500_000 }),
      }),
      fc.record({
        kind: fc.constant('undo' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        reviewPick: fc.nat(20),
        dt: fc.integer({ min: 1, max: 50_000 }),
      }),
    );

    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 5, maxLength: 30 }),
        fc.integer({ min: 1, max: 10_000 }),
        (actions, seed) => {
          const baseTime = Date.UTC(2026, 0, 1, 10, 0, 0);
          const f0 = createEventFactory('dev-a', 0, createHlcState('dev-a', baseTime));
          const f1 = createEventFactory('dev-b', 0, createHlcState('dev-b', baseTime + 300));
          const f2 = createEventFactory('dev-c', 0, createHlcState('dev-c', baseTime - 200));
          const factories = [f0, f1, f2] as const;

          const allEvents: FlashEvent[] = [];
          const createdReviewIds: string[] = [];

          // Initial deck + notes from dev-a
          allEvents.push(
            f0.create(
              'DeckCreated',
              {
                deck_id: deckId,
                name: 'Prop Deck',
                note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
                language: 'ko',
                created_at: baseTime,
              },
              baseTime,
            ),
          );
          for (let i = 0; i < noteKeys.length; i++) {
            const key = noteKeys[i];
            if (!key) continue;
            allEvents.push(
              f0.create(
                'NoteUpserted',
                {
                  note_id: deriveNoteId(deckId, key),
                  deck_id: deckId,
                  source_key: key,
                  fields: { word: `w${i}`, meaning: `m${i}` },
                  created_order: i,
                },
                baseTime + i + 1,
              ),
            );
          }

          let clock = baseTime + 1000;
          for (const act of actions) {
            clock += act.dt;
            const factory = factories[act.deviceIdx] ?? f0;
            if (act.kind === 'editField') {
              const key = noteKeys[act.noteIdx];
              if (!key) continue;
              allEvents.push(
                factory.create(
                  'NoteUpserted',
                  {
                    note_id: deriveNoteId(deckId, key),
                    deck_id: deckId,
                    source_key: key,
                    fields: { [act.field]: act.value },
                  },
                  clock,
                ),
              );
            } else if (act.kind === 'archiveToggle') {
              const key = noteKeys[act.noteIdx];
              if (!key) continue;
              allEvents.push(
                factory.create(
                  act.archive ? 'NoteArchived' : 'NoteRestored',
                  { note_id: deriveNoteId(deckId, key) },
                  clock,
                ),
              );
            } else if (act.kind === 'review') {
              const key = noteKeys[act.noteIdx];
              if (!key) continue;
              const noteId = deriveNoteId(deckId, key);
              const cardId = deriveCardId(noteId, layoutId, 0);
              const revId = `rev-${allEvents.length}-${act.deviceIdx}`;
              createdReviewIds.push(revId);
              allEvents.push(
                factory.create(
                  'ReviewRecorded',
                  {
                    review_id: revId,
                    card_id: cardId,
                    rating: act.rating,
                    reviewed_at: clock,
                    tz_offset: 0,
                    duration_ms: 1000,
                    answer_mode: 'flip',
                    fsrs_params_version: 0,
                    resulting_due_at: clock + 60_000,
                  },
                  clock,
                ),
              );
            } else if (act.kind === 'undo' && createdReviewIds.length > 0) {
              const targetRev = createdReviewIds[act.reviewPick % createdReviewIds.length];
              if (!targetRev) continue;
              allEvents.push(factory.create('ReviewUndone', { review_id: targetRev }, clock));
            }
          }

          // Deterministic Fisher-Yates shuffle into 3 different delivery orders + duplicates
          const shuffleWithSeed = (arr: FlashEvent[], s: number): FlashEvent[] => {
            const copy = [...arr];
            let x = s || 1;
            for (let i = copy.length - 1; i > 0; i--) {
              x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
              const j = x % (i + 1);
              const tmpI = copy[i];
              const tmpJ = copy[j];
              if (tmpI !== undefined && tmpJ !== undefined) {
                copy[i] = tmpJ;
                copy[j] = tmpI;
              }
            }
            return copy;
          };

          const order1 = allEvents;
          const order2 = [...allEvents].reverse();
          const order3 = [
            ...shuffleWithSeed(allEvents, seed),
            ...shuffleWithSeed(allEvents.slice(0, 5), seed + 7),
          ];

          // Apply in incremental chunks (simulating multi-batch sync)
          const replayChunked = (list: FlashEvent[], chunkSize: number): CollectionState => {
            const st = createEmptyState();
            for (let i = 0; i < list.length; i += chunkSize) {
              applyEvents(st, list.slice(i, i + chunkSize));
            }
            return st;
          };

          const snap1 = canonicalSnapshot(replayChunked(order1, allEvents.length));
          const snap2 = canonicalSnapshot(replayChunked(order2, 3));
          const snap3 = canonicalSnapshot(replayChunked(order3, 2));

          expect(snap2).toEqual(snap1);
          expect(snap3).toEqual(snap1);
        },
      ),
      { numRuns: 40 },
    );
  });
});
