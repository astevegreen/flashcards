import { describe, expect, it } from 'vitest';
import { applyEvents, createEventFactory, replayAllEvents } from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';

const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);

/**
 * D18: the app serializes the local snapshot when it queues the write, and stores it once the
 * queue has appended that batch. Events applied in between must not reach the stored copy, or
 * boot would re-apply them after a `localSeq` that predates them.
 */
describe('a serialized snapshot is detached from the live state', () => {
  it('stays the same when later edits and reviews mutate the state', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const noteId = deriveNoteId('d1', 'k1');
    const base: FlashEvent[] = [
      f.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Korean',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
        },
        t0,
      ),
      f.create(
        'NoteUpserted',
        { note_id: noteId, deck_id: 'd1', source_key: 'k1', fields: { word: '학교' } },
        t0 + 1,
      ),
    ];
    const state = replayAllEvents(base);
    const cardId = [...state.cards.keys()][0] ?? '';

    const snapshot = serializeCollectionState(state, { 'dev-a': 2 });
    const before = JSON.stringify(snapshot);

    applyEvents(state, [
      f.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: 'd1',
          source_key: 'k1',
          fields: { word: '학교', meaning: 'school' },
        },
        t0 + 2,
      ),
      f.create('NoteTagsAdded', { note_id: noteId, tags: ['later'] }, t0 + 3),
      f.create(
        'ReviewRecorded',
        {
          review_id: 'r1',
          card_id: cardId,
          rating: 3,
          reviewed_at: t0 + 60_000,
          tz_offset: 0,
          duration_ms: 1000,
          answer_mode: 'flip',
          fsrs_params_version: 0,
          resulting_due_at: t0 + 60_000,
        },
        t0 + 60_000,
      ),
    ]);

    expect(state.notes.get(noteId)?.fields['meaning']).toBe('school');
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

/**
 * Each hydration gets its own retained (unknown) events, array and objects: the folds read the
 * serialized events, and only the ones still unknown afterwards are copied (P9 keeps the rest).
 */
describe('hydrating a snapshot twice', () => {
  it('gives each state its own retained-events array', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const future = {
      ...f.create(
        'DeckCreated',
        { deck_id: 'd1', name: 'D', note_type_id: 'x', language: 'ko' },
        t0,
      ),
      type: 'FutureEvent',
      payload: { x: 1 },
    } as unknown as FlashEvent;
    const snapshot = serializeCollectionState(replayAllEvents([future]), { 'dev-a': 1 });
    expect(snapshot.unknownEvents).toHaveLength(1);

    const a = deserializeCollectionState(snapshot);
    const b = deserializeCollectionState(snapshot);
    expect(a.unknownEvents).not.toBe(b.unknownEvents);
    expect(a.unknownEvents).not.toBe(snapshot.unknownEvents);
    const later = {
      ...f.create(
        'DeckCreated',
        { deck_id: 'd2', name: 'E', note_type_id: 'x', language: 'ko' },
        t0 + 1,
      ),
      type: 'FutureEvent',
      payload: { x: 2 },
    } as unknown as FlashEvent;
    applyEvents(a, [later]);
    expect(a.unknownEvents).toHaveLength(2);
    expect(b.unknownEvents).toHaveLength(1);
    expect(snapshot.unknownEvents).toHaveLength(1);
  });

  it('gives each state its own retained events, so changing one changes no other', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const future = {
      ...f.create(
        'DeckCreated',
        { deck_id: 'd1', name: 'D', note_type_id: 'x', language: 'ko' },
        t0,
      ),
      type: 'FutureEvent',
      payload: { x: 1, nested: { list: ['a'] } },
    } as unknown as FlashEvent;
    const snapshot = serializeCollectionState(replayAllEvents([future]), { 'dev-a': 1 });
    const before = JSON.stringify(snapshot);

    const a = deserializeCollectionState(snapshot);
    const b = deserializeCollectionState(snapshot);
    expect(a.unknownEvents[0]).not.toBe(snapshot.unknownEvents[0]);
    expect(a.unknownEvents[0]).not.toBe(b.unknownEvents[0]);
    expect(a.unknownEvents[0]).toEqual(snapshot.unknownEvents[0]);

    // A later upgrade-in-place of a retained event (or any stray write) stays in its own state.
    const ev = a.unknownEvents[0] as unknown as {
      payload: { x: number; nested: { list: string[] } };
    };
    ev.payload.x = 99;
    ev.payload.nested.list.push('b');
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(b.unknownEvents[0]).toEqual(snapshot.unknownEvents[0]);

    // ...and a write to the serialized input never reaches a live state.
    (snapshot.unknownEvents[0] as unknown as { payload: { x: number } }).payload.x = 7;
    expect((b.unknownEvents[0] as unknown as { payload: { x: number } }).payload.x).toBe(1);
  });
});
