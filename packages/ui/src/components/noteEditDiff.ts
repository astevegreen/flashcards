/**
 * What a note-editor save should send (D7). Note fields replay per-field LWW and the tag list is
 * one LWW register, so re-sending an unchanged value at a fresh HLC would overwrite an edit made
 * on another device that hasn't synced yet. Only keys whose draft differs from the snapshot taken
 * when the dialog opened are sent, and tags only when the tag text was edited.
 */
export interface NoteEditChanges {
  fields: Record<string, string>;
  /** `undefined` when the tag text is unchanged since the dialog opened. */
  tags: string[] | undefined;
}

export interface NoteEditSnapshot {
  fields: Readonly<Record<string, string>>;
  tagsText: string;
}

export function parseTagsText(text: string): string[] {
  return text
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function noteEditChanges(
  opening: NoteEditSnapshot,
  draftFields: Readonly<Record<string, string>>,
  tagsText: string,
): NoteEditChanges {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(draftFields)) {
    if ((opening.fields[key] ?? '') !== value) fields[key] = value;
  }
  const tags = tagsText === opening.tagsText ? undefined : parseTagsText(tagsText);
  return { fields, tags };
}

/** The draft differs from the note as it was when the dialog opened (C11). */
export function hasNoteEditChanges(
  opening: NoteEditSnapshot,
  draftFields: Readonly<Record<string, string>>,
  tagsText: string,
): boolean {
  const changes = noteEditChanges(opening, draftFields, tagsText);
  return changes.tags !== undefined || Object.keys(changes.fields).length > 0;
}

/** Asked before a click outside the editor or Escape throws away unsaved edits (C11). */
export const DISCARD_NOTE_EDITS_PROMPT = 'Discard your changes to this note?';
