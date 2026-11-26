import type { CollectionState } from '../../events/replay.ts';
import type { Note } from '../../model/types.ts';
import { compareCodeUnits } from '../../compare.ts';

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

/**
 * Quotes a CSV / TSV cell when it holds a quote, the delimiter or a line break, or starts with
 * `#`: Anki's CSV reader treats a line starting with `#` as a comment and drops the row, and a
 * base91 GUID re-exported from Anki can start with `#`.
 */
export function escapeCsvCell(value: string, delimiter: string): string {
  if (
    value.startsWith('#') ||
    value.includes('"') ||
    value.includes(delimiter) ||
    /[\r\n]/.test(value)
  ) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
