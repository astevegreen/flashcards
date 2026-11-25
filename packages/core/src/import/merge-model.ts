import type { NoteType } from '../model/types.ts';

/**
 * Merges an imported note type into the one this collection already has under the same id.
 * Import never overwrites what the user has (follow-ups.md): the user's own fields, labels and
 * order stay, and only fields the existing type lacks are appended. `undefined` means nothing to
 * emit (the existing type already has every field). Used by the Anki and `.flashpkg` importers.
 */
export function mergedNoteType(
  existing: NoteType | undefined,
  next: NoteType,
): NoteType | undefined {
  if (!existing) return next;
  const known = new Set(existing.fields.map((f) => f.key));
  const added = next.fields.filter((f) => !known.has(f.key));
  if (added.length === 0) return undefined;
  return { ...existing, fields: [...existing.fields, ...added] };
}
