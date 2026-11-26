import type { CollectionState } from '../events/replay.ts';
import type { NoteUpsertedPayload } from '../events/types.ts';
import type { Note, NoteType, NoteTypeField } from '../model/types.ts';
import { isLinkedDeck } from './bulk.ts';
import { compareCodeUnits } from '../compare.ts';

/**
 * Find and replace across notes (Browse bulk edit). A pure planner: it turns a selection of
 * notes plus a search into `NoteUpserted` payloads that carry only the fields that change (note
 * fields are last-writer-wins per field, so a concurrent edit of another field is never
 * overwritten). Every change keeps its old text, so {@link planFindReplaceUndo} can put it back.
 *
 * Only text fields are searched (`text`, `reading`, `rich`); image and audio fields hold media
 * references. Inside a text field, `media:<sha256>` references are never matched or changed, so
 * a search for "a" can't break an image link. Everything else is literal text: ruby, cloze and
 * rich-text markup are searched as typed, as in the field editor.
 */

export interface FindReplaceOptions {
  find: string;
  replace: string;
  /** One field key to search, or every text field when omitted. */
  fieldKey?: string;
  /** Default false: case-insensitive. */
  matchCase?: boolean;
  /** Treat `find` as a JavaScript regular expression; `replace` may use `$1`, `$&` and so on. */
  regex?: boolean;
}

export type FindReplaceError = { code: 'empty_find' } | { code: 'invalid_regex'; message: string };

/** One field a replace changed: what it held before and after. */
export interface FindReplaceChange {
  noteId: string;
  fieldKey: string;
  before: string;
  after: string;
}

export interface FindReplacePlan {
  payloads: NoteUpsertedPayload[];
  changes: FindReplaceChange[];
  changedNoteCount: number;
  /** Matches replaced, over all fields. */
  replacementCount: number;
  /** Changed notes in decks fed by a Sheet, folder or package: the next refresh may undo them. */
  linkedNoteCount: number;
  error?: FindReplaceError;
}

const SEARCHABLE_KINDS = new Set(['text', 'reading', 'rich']);
/** A media reference, kept whole (same shape as `events/media-refs.ts`). */
const MEDIA_REF = /media:[0-9a-f]{64}/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The note's searchable fields, in note type order. */
export function searchableFields(noteType: NoteType | undefined): NoteTypeField[] {
  return (noteType?.fields ?? []).filter((f) => SEARCHABLE_KINDS.has(f.kind));
}

function compile(options: FindReplaceOptions): RegExp | FindReplaceError {
  const find = options.find.normalize('NFC');
  if (find.length === 0) return { code: 'empty_find' };
  const flags = options.matchCase ? 'gu' : 'giu';
  try {
    return new RegExp(options.regex ? find : escapeRegExp(find), flags);
  } catch (err) {
    return { code: 'invalid_regex', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `String.prototype.replace` substitution patterns (`$$`, `$&`, `` $` ``, `$'`, `$1`-`$99`,
 * `$<name>`) for one match, from the arguments a replace callback receives. Done by hand because
 * the callback form (needed to skip zero-length matches) does not expand them.
 */
function expandReplacement(replacement: string, args: unknown[]): string {
  const last = args.at(-1);
  const named =
    typeof last === 'object' && last !== null ? (last as Record<string, unknown>) : null;
  const tail = named ? 3 : 2;
  const match = String(args[0]);
  const groups = args.slice(1, args.length - tail);
  const offset = Number(args[args.length - tail]);
  const input = String(args[args.length - tail + 1]);
  return replacement.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g, (token, what: string, name) => {
    if (what === '$') return '$';
    if (what === '&') return match;
    if (what === '`') return input.slice(0, offset);
    if (what === "'") return input.slice(offset + match.length);
    if (typeof name === 'string') {
      if (!named) return token;
      return groupText(named[name]);
    }
    // `$12` means group 12 when it exists, else group 1 followed by "2".
    const two = Number(what);
    if (what.length === 2 && two >= 1 && two <= groups.length) return groupText(groups[two - 1]);
    const one = Number(what[0]);
    if (one >= 1 && one <= groups.length) return groupText(groups[one - 1]) + what.slice(1);
    return token;
  });
}

/** A capture group's text: a string, or `undefined` for a group that did not take part. */
function groupText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Replaces outside media references; returns the new text and how many matches changed. */
function replaceInText(
  text: string,
  pattern: RegExp,
  options: FindReplaceOptions,
): { text: string; count: number } {
  const replacement = options.replace.normalize('NFC');
  let count = 0;
  const replaceSegment = (segment: string): string => {
    if (segment.length === 0) return segment;
    pattern.lastIndex = 0;
    return segment.replace(pattern, (...args: unknown[]) => {
      const match = String(args[0]);
      // A zero-length match (`^`, `x*`) would insert text everywhere: skip it.
      if (match.length === 0) return match;
      count += 1;
      return options.regex ? expandReplacement(replacement, args) : replacement;
    });
  };
  let out = '';
  let last = 0;
  MEDIA_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_REF.exec(text)) !== null) {
    out += replaceSegment(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += replaceSegment(text.slice(last));
  return { text: out, count };
}

function selectedNotes(state: CollectionState, noteIds: Iterable<string>): Note[] {
  const out: Note[] = [];
  for (const id of new Set(noteIds)) {
    const note = state.notes.get(id);
    if (note) out.push(note);
  }
  return out.sort((a, b) => compareCodeUnits(a.id, b.id));
}

function noteTypeOf(state: CollectionState, note: Note): NoteType | undefined {
  const id = state.decks.get(note.deck_id)?.note_type_id;
  return id ? state.noteTypes.get(id) : undefined;
}

/** The note's changed fields; adds each change and its match count to `plan`. */
function replaceInNote(
  state: CollectionState,
  note: Note,
  pattern: RegExp,
  options: FindReplaceOptions,
  plan: FindReplacePlan,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const field of searchableFields(noteTypeOf(state, note))) {
    if (options.fieldKey !== undefined && field.key !== options.fieldKey) continue;
    const before = note.fields[field.key];
    if (!before) continue;
    const { text: after, count } = replaceInText(before, pattern, options);
    if (count === 0 || after === before) continue;
    fields[field.key] = after;
    plan.replacementCount += count;
    plan.changes.push({ noteId: note.id, fieldKey: field.key, before, after });
  }
  return fields;
}

export function planFindReplace(
  state: CollectionState,
  noteIds: Iterable<string>,
  options: FindReplaceOptions,
): FindReplacePlan {
  const empty: FindReplacePlan = {
    payloads: [],
    changes: [],
    changedNoteCount: 0,
    replacementCount: 0,
    linkedNoteCount: 0,
  };
  const pattern = compile(options);
  if (!(pattern instanceof RegExp)) return { ...empty, error: pattern };
  const plan = empty;
  for (const note of selectedNotes(state, noteIds)) {
    const fields = replaceInNote(state, note, pattern, options, plan);
    if (Object.keys(fields).length === 0) continue;
    plan.payloads.push({
      note_id: note.id,
      deck_id: note.deck_id,
      source_key: note.source_key,
      fields,
    });
    plan.changedNoteCount += 1;
    if (isLinkedDeck(state.decks.get(note.deck_id))) plan.linkedNoteCount += 1;
  }
  return plan;
}

export interface FindReplaceUndoPlan {
  payloads: NoteUpsertedPayload[];
  /** Fields put back to their old text. */
  restoredCount: number;
  /** Fields edited again since the replace (or whose note is gone): left as they are. */
  skippedCount: number;
}

/**
 * Puts back the old text of each field a replace changed, but only where the field still holds
 * the replaced text, so an edit made since (on this device or synced in) is never lost.
 */
export function planFindReplaceUndo(
  state: CollectionState,
  changes: readonly FindReplaceChange[],
): FindReplaceUndoPlan {
  const byNote = new Map<string, Record<string, string>>();
  let restoredCount = 0;
  let skippedCount = 0;
  for (const change of changes) {
    const note = state.notes.get(change.noteId);
    if (note?.fields[change.fieldKey] !== change.after) {
      skippedCount += 1;
      continue;
    }
    const fields = byNote.get(note.id) ?? {};
    fields[change.fieldKey] = change.before;
    byNote.set(note.id, fields);
    restoredCount += 1;
  }
  const payloads: NoteUpsertedPayload[] = [];
  for (const [noteId, fields] of [...byNote.entries()].sort((a, b) =>
    compareCodeUnits(a[0], b[0]),
  )) {
    const note = state.notes.get(noteId);
    if (!note) continue;
    payloads.push({ note_id: note.id, deck_id: note.deck_id, source_key: note.source_key, fields });
  }
  return { payloads, restoredCount, skippedCount };
}
