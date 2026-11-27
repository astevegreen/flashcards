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
 * Finds the note of a deck that an imported record id came from: the inverse of
 * `uniqueRecordIds`. `notes` is the deck in export order (`created_order`, then id). Each note is
 * matched at most once. The candidates for a record id are:
 * - the note `uniqueRecordIds` gives that id when it is replayed over the deck's live notes
 *   (what a whole-deck export writes);
 * - notes whose source key is the record id;
 * - the note whose id is the record id (it lost the race for its key, so it went under its id),
 *   or that id without a `~n` suffix.
 * The best free candidate wins: a live note before an archived one (archived notes are never
 * exported), then one whose content equals the record (`sameContent`: a subset export numbers
 * fewer notes, so the replay can name another one), then the replay's pick, then the order above.
 */
export function existingNoteMatcher(
  notes: readonly Note[],
): (recordId: string, sameContent?: (note: Note) => boolean) => Note | undefined {
  const live = notes.filter((note) => !note.archived);
  const replay = new Map<string, Note>();
  uniqueRecordIds(live).forEach((id, i) => {
    const note = live[i];
    if (note) replay.set(id, note);
  });
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
  return (recordId, sameContent) => {
    const picked = replay.get(recordId);
    const candidates = [
      picked,
      ...(bySourceKey.get(recordId) ?? []),
      byId.get(recordId),
      byId.get(recordId.replace(/~\d+$/, '')),
    ];
    let best: Note | undefined;
    let bestRank = Infinity;
    for (const note of candidates) {
      if (!note || matched.has(note.id)) continue;
      const rank =
        (note.archived ? 4 : 0) + (sameContent?.(note) ? 0 : 2) + (note === picked ? 0 : 1);
      if (rank < bestRank) [best, bestRank] = [note, rank];
    }
    if (best) matched.add(best.id);
    return best;
  };
}
