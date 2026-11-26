import type { CollectionState } from '../../events/replay.ts';
import type { Note } from '../../model/types.ts';
import { compareCodeUnits } from '../../compare.ts';
import { escapeDelimitedCell } from '../../import/csv-cell.ts';

/**
 * Small helpers kept inside the lazy `@flash/core/anki-export` entry. They mirror
 * `selectCsvExportNotes`-style logic in `csv-export.ts` instead of importing new names from
 * modules in the initial bundle, which would grow it (§8).
 */

export interface NoteSelection {
  deckId: string;
  noteIds?: Iterable<string>;
  includeArchived?: boolean;
}

/** The deck's notes to export, in the deck's note order (same rule as `exportCsv`). */
export function selectDeckNotes(state: CollectionState, options: NoteSelection): Note[] {
  const wanted = options.noteIds ? new Set(options.noteIds) : null;
  const notes: Note[] = [];
  for (const note of state.notes.values()) {
    if (note.deck_id !== options.deckId) continue;
    if (note.archived && options.includeArchived !== true) continue;
    if (wanted && !wanted.has(note.id)) continue;
    notes.push(note);
  }
  return notes.sort((a, b) => a.created_order - b.created_order || compareCodeUnits(a.id, b.id));
}

/** A CSV / TSV cell for Anki: also quoted when it starts with `#` (Anki reads that as a comment). */
export function escapeCsvCell(value: string, delimiter: string): string {
  return escapeDelimitedCell(value, delimiter, { quoteLeadingHash: true });
}
