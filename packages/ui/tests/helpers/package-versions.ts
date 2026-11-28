import {
  applyEvents,
  compareCodeUnits,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveNoteId,
  type CollectionState,
} from '@flash/core';
import { exportFlashpkg } from '@flash/core/flashpkg';

const DECK = 'pkg-deck';

/** Versions of one package deck ("Words", `pkg:words`) holding a note per key (C9 tests). */
export function packageBytes(keys: readonly string[], version: string): Uint8Array {
  const pkgState = createEmptyState();
  const f = createEventFactory('cli', 0, createHlcState('cli', 500));
  applyEvents(pkgState, [
    f.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: 'Words',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      },
      500,
    ),
    ...keys.map((k) =>
      f.create(
        'NoteUpserted',
        { note_id: deriveNoteId(DECK, k), deck_id: DECK, source_key: k, fields: { word: k } },
        500,
      ),
    ),
  ]);
  return exportFlashpkg(pkgState, { packageId: 'pkg:words', name: 'Words', version });
}

/** The `word` of every active note, sorted by code unit. */
export function activeWords(state: CollectionState): string[] {
  return [...state.notes.values()]
    .filter((n) => !n.archived)
    .map((n) => n.fields['word'] ?? '')
    .sort(compareCodeUnits);
}
