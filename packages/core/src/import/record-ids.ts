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

/**
 * Finds the note of a deck that an imported record id came from, the inverse of
 * `uniqueRecordIds`: each note is matched at most once, tried in this order:
 * 1. a note whose source key is the record id: the first not yet matched, in `notes` order (the
 *    exporter's order, so the note that won the record id gets it back);
 * 2. a note whose id is the record id: it lost the race for its source key, so it was exported
 *    under its note id;
 * 3. a note whose id is the record id without its `~n` suffix.
 * Without 2 and 3 a re-import into the same collection added a copy of every note that lost.
 */
export function existingNoteMatcher(
  notes: readonly Note[],
): (recordId: string) => Note | undefined {
  const bySourceKey = new Map<string, Note[]>();
  const byId = new Map<string, Note>();
  for (const note of notes) {
    byId.set(note.id, note);
    if (!note.source_key) continue;
    const list = bySourceKey.get(note.source_key);
    if (list) list.push(note);
    else bySourceKey.set(note.source_key, [note]);
  }
  const matched = new Set<string>();
  const free = (note: Note | undefined) => (note && !matched.has(note.id) ? note : undefined);
  return (recordId) => {
    const found =
      bySourceKey.get(recordId)?.find((note) => !matched.has(note.id)) ??
      free(byId.get(recordId)) ??
      free(byId.get(recordId.replace(/~\d+$/, '')));
    if (found) matched.add(found.id);
    return found;
  };
}
