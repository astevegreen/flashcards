import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEventFactory,
  replayAllEvents,
  type CollectionState,
} from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';

const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);
const PACKAGE_ID = 'pkg:archive-count-test';

type Factory = ReturnType<typeof createEventFactory>;

function noteEvent(factory: Factory, id: string, sourceKey: string, word: string, order: number) {
  return factory.create(
    'NoteUpserted',
    {
      note_id: id,
      deck_id: 'deck-src',
      source_key: sourceKey,
      fields: { word, meaning: word },
      tags: [],
      provenance: { source: 'import', reviewed: true },
      created_order: order,
    },
    T0 + order + 1,
  );
}

/** The author's deck at v1 (k1, k2, k3) and at v2, where k2 and k3 were replaced by k4 and k5. */
function authorVersions(): { v1: Uint8Array; v2: Uint8Array; v2Subset: Uint8Array } {
  const author = createEventFactory('dev-author', 0, createHlcState('dev-author', T0));
  const v1Events = [
    author.create(
      'DeckCreated',
      { deck_id: 'deck-src', name: 'Words', note_type_id: 'preset:vocab-ko', language: 'ko' },
      T0,
    ),
    noteEvent(author, 'a1', 'k1', '나무', 0),
    noteEvent(author, 'a2', 'k2', '하늘', 1),
    noteEvent(author, 'a3', 'k3', '바다', 2),
  ];
  const v1State = replayAllEvents(v1Events);
  const v2State = applyEvents(replayAllEvents(v1Events), [
    author.create('NoteArchived', { note_id: 'a2' }, T0 + 100),
    author.create('NoteArchived', { note_id: 'a3' }, T0 + 101),
    noteEvent(author, 'a4', 'k4', '하늘 (sky)', 3),
    noteEvent(author, 'a5', 'k5', '바다 (sea)', 4),
  ]);
  return {
    v1: exportFlashpkg(v1State, { deckId: 'deck-src', packageId: PACKAGE_ID }),
    v2: exportFlashpkg(v2State, { deckId: 'deck-src', packageId: PACKAGE_ID }),
    v2Subset: exportFlashpkg(v2State, {
      deckId: 'deck-src',
      packageId: PACKAGE_ID,
      noteIds: ['a4'],
    }),
  };
}

function userWithV1(v1: Uint8Array): { state: CollectionState; user: Factory } {
  const user = createEventFactory('dev-user', 0, createHlcState('dev-user', T0 + 10_000));
  const first = importFlashpkg(v1, replayAllEvents([]), user, {
    nowMs: T0 + 10_000,
    archiveRemovedOnUpgrade: true,
  });
  expect(first.notesArchived).toBe(0);
  return { state: replayAllEvents(first.events), user };
}

function activeNoteCount(state: CollectionState): number {
  return [...state.notes.values()].filter((n) => !n.archived).length;
}

describe('importFlashpkg notesArchived (C9 re-import preview)', () => {
  it('counts the notes an upgrade archives, matching its NoteArchived events and replay', () => {
    const { v1, v2 } = authorVersions();
    const { state, user } = userWithV1(v1);
    const res = importFlashpkg(v2, state, user, {
      nowMs: T0 + 20_000,
      archiveRemovedOnUpgrade: true,
    });
    expect(res.notesArchived).toBe(2);
    expect(res.events.filter((e) => e.type === 'NoteArchived')).toHaveLength(2);

    const before = activeNoteCount(state);
    const after = applyEvents(state, res.events);
    // k2 and k3 archived, k4 and k5 added.
    expect(activeNoteCount(after)).toBe(before - 2 + 2);
  });

  it('is zero without archiveRemovedOnUpgrade', () => {
    const { v1, v2 } = authorVersions();
    const { state, user } = userWithV1(v1);
    const res = importFlashpkg(v2, state, user, { nowMs: T0 + 20_000 });
    expect(res.notesArchived).toBe(0);
    expect(res.events.some((e) => e.type === 'NoteArchived')).toBe(false);
  });

  it('is zero when the same version is imported again', () => {
    const { v1 } = authorVersions();
    const { state, user } = userWithV1(v1);
    const res = importFlashpkg(v1, state, user, {
      nowMs: T0 + 20_000,
      archiveRemovedOnUpgrade: true,
    });
    expect(res.notesArchived).toBe(0);
  });

  it('is zero for a subset package, which never archives the deck’s other notes', () => {
    const { v1, v2Subset } = authorVersions();
    const { state, user } = userWithV1(v1);
    const res = importFlashpkg(v2Subset, state, user, {
      nowMs: T0 + 20_000,
      archiveRemovedOnUpgrade: true,
    });
    expect(res.notesArchived).toBe(0);
  });

  it('leaves out notes the user already archived', () => {
    const { v1, v2 } = authorVersions();
    const { state, user } = userWithV1(v1);
    const k2 = [...state.notes.values()].find((n) => n.source_key === 'k2');
    if (!k2) throw new Error('expected the k2 note');
    const archivedByUser = applyEvents(state, [
      user.create('NoteArchived', { note_id: k2.id }, T0 + 15_000),
    ]);
    const res = importFlashpkg(v2, archivedByUser, user, {
      nowMs: T0 + 20_000,
      archiveRemovedOnUpgrade: true,
    });
    expect(res.notesArchived).toBe(1);
  });
});
