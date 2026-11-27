import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEventFactory,
  replayAllEvents,
  type CollectionState,
} from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import { existingNoteMatcher } from '../src/import/record-ids.ts';
import type { Note } from '../src/model/types.ts';

const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const PACKAGE_ID = 'pkg:reimport-test';

function noteEvent(
  factory: ReturnType<typeof createEventFactory>,
  deckId: string,
  id: string,
  sourceKey: string,
  word: string,
  order: number,
) {
  return factory.create(
    'NoteUpserted',
    {
      note_id: id,
      deck_id: deckId,
      source_key: sourceKey,
      fields: { word, meaning: word },
      tags: [],
      provenance: { source: 'import', reviewed: true },
      created_order: order,
    },
    T0 + order + 1,
  );
}

/**
 * A deck imported from a package (`source.package_id` set) that then gained notes sharing a
 * source key: one moved in from a deck linked to the same sheet, and one whose own id is a key.
 */
function packageDeckWithDuplicateKeys(): { state: CollectionState; deckId: string } {
  const author = createEventFactory('dev-author', 0, createHlcState('dev-author', T0));
  const authored = replayAllEvents([
    author.create(
      'DeckCreated',
      { deck_id: 'deck-src', name: 'Words', note_type_id: 'preset:vocab-ko', language: 'ko' },
      T0,
    ),
    noteEvent(author, 'deck-src', 'a1', 'k1', '나무', 0),
    noteEvent(author, 'deck-src', 'a2', 'k2', '하늘', 1),
  ]);
  const pkg = exportFlashpkg(authored, { deckId: 'deck-src', packageId: PACKAGE_ID });

  const user = createEventFactory('dev-user', 0, createHlcState('dev-user', T0 + 10_000));
  const first = importFlashpkg(pkg, replayAllEvents([]), user, { nowMs: T0 + 10_000 });
  let state = replayAllEvents(first.events);
  const deck = [...state.decks.values()][0];
  if (deck?.source?.package_id !== PACKAGE_ID) throw new Error('expected a package-origin deck');
  state = applyEvents(state, [
    noteEvent(user, deck.id, 'moved-in', 'k1', '물', 50),
    noteEvent(user, deck.id, 'k2', '', '불', 51),
  ]);
  return { state, deckId: deck.id };
}

function deckWords(state: CollectionState, deckId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const note of state.notes.values()) {
    if (note.deck_id === deckId && !note.archived) out[note.id] = note.fields['word'] ?? '';
  }
  return out;
}

describe('.flashpkg export then re-import into the same collection', () => {
  it('matches every note, including the ones that lost the record-id race', () => {
    const { state, deckId } = packageDeckWithDuplicateKeys();
    const before = deckWords(state, deckId);
    expect(Object.keys(before)).toHaveLength(4);

    const bytes = exportFlashpkg(state, { deckId, packageId: PACKAGE_ID });
    const f = createEventFactory('dev-user', 100, createHlcState('dev-user', T0 + 20_000));
    const res = importFlashpkg(bytes, state, f, {
      nowMs: T0 + 20_000,
      archiveRemovedOnUpgrade: true,
    });
    // Nothing changed, so nothing is written: no copy, no overwrite, nothing archived.
    expect(res.events.filter((e) => e.type.startsWith('Note'))).toEqual([]);
    const after = applyEvents(state, res.events);
    expect(deckWords(after, deckId)).toEqual(before);
    expect(after.notes.get('moved-in')?.source_key).toBe('k1');
  });

  it('updates the note that lost the race in place, keeping its own key', () => {
    const { state, deckId } = packageDeckWithDuplicateKeys();
    const edited = applyEvents(state, [
      createEventFactory('dev-x', 0, createHlcState('dev-x', T0 + 30_000)).create(
        'NoteUpserted',
        {
          note_id: 'moved-in',
          deck_id: deckId,
          source_key: 'k1',
          fields: { word: '물!', meaning: 'water' },
          tags: [],
          provenance: { source: 'import', reviewed: true },
          created_order: 50,
        },
        T0 + 30_000,
      ),
    ]);
    const bytes = exportFlashpkg(edited, { deckId, packageId: PACKAGE_ID });
    const f = createEventFactory('dev-user', 200, createHlcState('dev-user', T0 + 40_000));
    const res = importFlashpkg(bytes, state, f, { nowMs: T0 + 40_000 });
    const after = applyEvents(state, res.events);
    expect(Object.keys(deckWords(after, deckId))).toHaveLength(4);
    expect(after.notes.get('moved-in')?.fields['word']).toBe('물!');
    expect(after.notes.get('moved-in')?.source_key).toBe('k1');
  });
});

describe('existingNoteMatcher', () => {
  const note = (id: string, sourceKey: string): Note =>
    ({ id, source_key: sourceKey }) as unknown as Note;

  it('gives each record id back to the note uniqueRecordIds wrote it for', () => {
    const notes = [note('n1', 'k'), note('n2', 'k'), note('k', '')];
    const match = existingNoteMatcher(notes);
    // uniqueRecordIds writes these as k, n2 and k~2.
    expect(match('k')?.id).toBe('n1');
    expect(match('n2')?.id).toBe('n2');
    expect(match('k~2')?.id).toBe('k');
    expect(match('k')).toBeUndefined();
    expect(match('other')).toBeUndefined();
  });

  it('matches a shared source key to the next unmatched note', () => {
    const match = existingNoteMatcher([note('n1', 'k'), note('n2', 'k')]);
    expect(match('k')?.id).toBe('n1');
    expect(match('k')?.id).toBe('n2');
  });
});
