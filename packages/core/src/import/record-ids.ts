import type { Note } from '../model/types.ts';

/**
 * The id each exported note is written under (`.flashpkg` record id, CSV `Card ID`), in `notes`
 * order: its source key, else its note id. Importers key notes by that id, so one written twice
 * would merge two notes into one. A note whose id is taken falls back to its note id, then to a
 * numbered variant of it (C19).
 */
export function uniqueRecordIds(notes: readonly Note[]): string[] {
  const used = new Set<string>();
  return notes.map((note) => {
    let id = note.source_key || note.id;
    if (used.has(id)) id = note.id;
    for (let n = 2; used.has(id); n++) id = `${note.id}~${n}`;
    used.add(id);
    return id;
  });
}
