import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEventFactory,
  replayAllEvents,
  type CollectionState,
} from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import { existingNoteMatcher, uniqueRecordIds } from '../src/import/record-ids.ts';
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

describe('re-import picks the note the exporter wrote under a shared key', () => {
  /** A package-origin deck where an older note `old` and a newer note `new` share the key `k`. */
  function sharedKeyDeck(archiveOld: boolean): { state: CollectionState; deckId: string } {
    const { state: base, deckId } = packageDeckWithDuplicateKeys();
    const f = createEventFactory('dev-user', 300, createHlcState('dev-user', T0 + 50_000));
    const events = [
      noteEvent(f, deckId, 'old', 'k', '옛것', -2),
      noteEvent(f, deckId, 'new', 'k', '새것', 60),
    ];
    if (archiveOld) events.push(f.create('NoteArchived', { note_id: 'old' }, T0 + 50_001));
    return { state: applyEvents(base, events), deckId };
  }

  function reimport(state: CollectionState, bytes: Uint8Array) {
    const f = createEventFactory('dev-user', 400, createHlcState('dev-user', T0 + 60_000));
    const res = importFlashpkg(bytes, state, f, {
      nowMs: T0 + 60_000,
      archiveRemovedOnUpgrade: true,
    });
    return { res, after: applyEvents(state, res.events) };
  }

  it('an archived older note with the same key is not restored over the live one', () => {
    const { state, deckId } = sharedKeyDeck(true);
    const { res, after } = reimport(
      state,
      exportFlashpkg(state, { deckId, packageId: PACKAGE_ID }),
    );
    expect(res.events.filter((e) => e.type.startsWith('Note'))).toEqual([]);
    expect(after.notes.get('old')?.archived).toBe(true);
    expect(after.notes.get('new')?.archived).toBeFalsy();
    expect(after.notes.get('new')?.fields['word']).toBe('새것');
  });

  it('a subset export of the newer note matches it by content, not the older one', () => {
    const { state, deckId } = sharedKeyDeck(false);
    const bytes = exportFlashpkg(state, { deckId, packageId: PACKAGE_ID, noteIds: ['new'] });
    const { res, after } = reimport(state, bytes);
    expect(res.events.filter((e) => e.type.startsWith('Note'))).toEqual([]);
    expect(after.notes.get('old')?.fields['word']).toBe('옛것');
    expect(after.notes.get('new')?.fields['word']).toBe('새것');
  });
});

describe('re-import of a deck where a note id equals a later note key', () => {
  it('matches each note to its own record, with no copy and nothing archived', () => {
    const { state: base, deckId } = packageDeckWithDuplicateKeys();
    const f = createEventFactory('dev-user', 500, createHlcState('dev-user', T0 + 70_000));
    // `id-key` sorts before `later`, and `later` is keyed `id-key`.
    const state = applyEvents(base, [
      noteEvent(f, deckId, 'id-key', '', '첫째', -5),
      noteEvent(f, deckId, 'later', 'id-key', '둘째', 70),
    ]);
    const bytes = exportFlashpkg(state, { deckId, packageId: PACKAGE_ID });
    const g = createEventFactory('dev-user', 600, createHlcState('dev-user', T0 + 80_000));
    const res = importFlashpkg(bytes, state, g, {
      nowMs: T0 + 80_000,
      archiveRemovedOnUpgrade: true,
    });
    expect(res.events.filter((e) => e.type.startsWith('Note'))).toEqual([]);
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

  it('gives a note whose id is a key, ordered first, its own record back (agy, #102)', () => {
    // uniqueRecordIds writes `k` for the note whose id is k, and `n2` for the note keyed k.
    const notes = [note('k', ''), note('n2', 'k')];
    expect(uniqueRecordIds(notes)).toEqual(['k', 'n2']);
    const match = existingNoteMatcher(notes);
    expect(match('k')?.id).toBe('k');
    expect(match('n2')?.id).toBe('n2');
  });

  it('skips archived notes the way the exporter does', () => {
    const archived = { ...note('a', 'k'), archived: true } as Note;
    const notes = [archived, note('b', 'k')];
    expect(existingNoteMatcher(notes)('k')?.id).toBe('b');
  });

  it('matches a shared source key to the next unmatched note', () => {
    const match = existingNoteMatcher([note('n1', 'k'), note('n2', 'k')]);
    expect(match('k')?.id).toBe('n1');
    expect(match('k')?.id).toBe('n2');
  });
});
