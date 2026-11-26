import { compareHlc } from '../hlc.ts';
import type { Note } from '../model/types.ts';
import { compareCodeUnits } from '../compare.ts';
import type { CollectionState } from './replay.ts';

/**
 * `NoteTagsAdded` (set-union tag adds, used for automatic `leech` tagging and its backfill).
 *
 * A note's `tags` stay one LWW register (`note:<id>:tags`, written by `NoteUpserted`). On top of
 * it, every added tag has a grow-only HLC register inside the existing per-field HLC registry
 * (`CollectionState.fieldHlcs`):
 *
 * - `note:<id>:tagadd:<tag>` = max HLC of every `NoteTagsAdded { note_id, tags }` naming `<tag>`
 *
 * The visible tags are `R \ L ++ sort(L)`, where `R` is the winning `NoteUpserted` tag list and
 * `L` the added tags whose add register is newer than the tags register (all adds when the note
 * has no tags register yet). So an add survives any tag edit with an OLDER HLC, while a tag edit
 * with a newer HLC wins: the user removing `leech` or an Undo after the add, but also a concurrent
 * edit from a device that had not seen the add yet and happens to carry the later HLC (that drops
 * the automatic tag, and the backfill does not re-add it, since the note has an add register).
 * Every input is a max
 * or LWW register, so any delivery order, duplicate or chunking yields the same tags in the same
 * order, and two devices adding the same tag concurrently never duplicate it.
 *
 * Reusing `fieldHlcs` keeps the snapshot and sync formats unchanged: older builds serialize every
 * `fieldHlcs` entry verbatim and keep the raw events in `unknownEvents`
 * (see {@link foldTagAddEventsFromUnknown}).
 */
export const NOTE_TAGS_ADDED = 'NoteTagsAdded';

/** Most tags one `NoteTagsAdded` may add (defensive cap against hand-edited logs). */
const MAX_ADDED_TAGS = 32;

const TAG_ADD_MARKER = ':tagadd:';

/** Canonical spelling of an added tag (NFC, trimmed, lowercase), or `''` when empty. */
export function normalizeAddedTag(tag: string): string {
  return tag.normalize('NFC').trim().toLowerCase();
}

export function tagAddRegisterKey(noteId: string, tag: string): string {
  return `note:${noteId}${TAG_ADD_MARKER}${normalizeAddedTag(tag)}`;
}

function tagsRegisterKey(noteId: string): string {
  return `note:${noteId}:tags`;
}

/** Splits a `note:<id>:tagadd:<tag>` key, or `undefined` for any other key. */
function parseTagAddKey(key: string): { noteId: string; tag: string } | undefined {
  if (!key.startsWith('note:')) return undefined;
  const at = key.indexOf(TAG_ADD_MARKER);
  if (at <= 'note:'.length) return undefined;
  const tag = key.slice(at + TAG_ADD_MARKER.length);
  return tag.length > 0 ? { noteId: key.slice('note:'.length, at), tag } : undefined;
}

/** Reads `{ note_id, tags }` defensively (events may come from any build or a hand-edited file). */
export function readTagAddPayload(
  payload: unknown,
): { noteId: string; tags: string[] } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as { note_id?: unknown; tags?: unknown };
  if (typeof p.note_id !== 'string' || p.note_id.length === 0 || !Array.isArray(p.tags)) {
    return undefined;
  }
  const tags = new Set<string>();
  for (const raw of p.tags.slice(0, MAX_ADDED_TAGS)) {
    if (typeof raw !== 'string') continue;
    const tag = normalizeAddedTag(raw);
    if (tag.length > 0) tags.add(tag);
  }
  return tags.size > 0 ? { noteId: p.note_id, tags: [...tags] } : undefined;
}

/**
 * noteId -> added tags, derived from the `fieldHlcs` registers. Built lazily once per state
 * object and kept up to date by {@link applyTagAddRegisters} and {@link recordTagAddKeys}, so
 * replay never scans the whole registry per event.
 */
const tagAddIndexes = new WeakMap<CollectionState, Map<string, Set<string>>>();

function addToIndex(index: Map<string, Set<string>>, noteId: string, tag: string): void {
  const set = index.get(noteId);
  if (set) set.add(tag);
  else index.set(noteId, new Set([tag]));
}

/** @internal snapshot-upgrade only (`snapshot-upgrade.ts`); otherwise called only inside this module. */
export function tagAddIndex(state: CollectionState): Map<string, Set<string>> {
  let index = tagAddIndexes.get(state);
  if (!index) {
    index = new Map();
    for (const key of state.fieldHlcs.keys()) {
      const parsed = parseTagAddKey(key);
      if (parsed) addToIndex(index, parsed.noteId, parsed.tag);
    }
    tagAddIndexes.set(state, index);
  }
  return index;
}

/** Keeps the index in step with `fieldHlcs` keys merged from elsewhere (Worker state patches). */
export function recordTagAddKeys(state: CollectionState, keys: Iterable<string>): void {
  const index = tagAddIndexes.get(state);
  if (!index) return; // Built lazily from `fieldHlcs` on first use.
  for (const key of keys) {
    const parsed = parseTagAddKey(key);
    if (parsed) addToIndex(index, parsed.noteId, parsed.tag);
  }
}

/** True when `tag` was ever added to the note with `NoteTagsAdded` (on any device). */
export function hasTagAddRegister(state: CollectionState, noteId: string, tag: string): boolean {
  return state.fieldHlcs.has(tagAddRegisterKey(noteId, tag));
}

/**
 * Max-merges one `NoteTagsAdded` into the add registers. Returns the register keys that
 * advanced. Malformed payloads are ignored (no throw).
 */
export function applyTagAddRegisters(
  state: CollectionState,
  payload: unknown,
  hlc: string,
): { noteId: string; keys: string[] } | undefined {
  const parsed = readTagAddPayload(payload);
  if (!parsed || typeof hlc !== 'string' || hlc.length === 0) return undefined;
  const index = tagAddIndex(state);
  const keys: string[] = [];
  for (const tag of parsed.tags) {
    const key = tagAddRegisterKey(parsed.noteId, tag);
    const prev = state.fieldHlcs.get(key);
    if (prev !== undefined && compareHlc(hlc, prev) <= 0) continue;
    state.fieldHlcs.set(key, hlc);
    addToIndex(index, parsed.noteId, tag);
    keys.push(key);
  }
  return { noteId: parsed.noteId, keys };
}

/** The note's added tags that currently win over its tags register, in code-unit order. */
function winningAddedTags(state: CollectionState, noteId: string): string[] {
  const added = tagAddIndex(state).get(noteId);
  if (!added || added.size === 0) return [];
  const registerHlc = state.fieldHlcs.get(tagsRegisterKey(noteId));
  const winners: string[] = [];
  for (const tag of added) {
    const addHlc = state.fieldHlcs.get(tagAddRegisterKey(noteId, tag));
    if (addHlc === undefined) continue;
    if (registerHlc === undefined || compareHlc(addHlc, registerHlc) > 0) winners.push(tag);
  }
  return winners.sort(compareCodeUnits);
}

/**
 * Rewrites `note.tags` into the canonical `R \ L ++ sort(L)` form (see the module doc). `note.tags`
 * is either the freshly written register value or an earlier canonical form, and both give the
 * same result, so this is safe after any event. Returns true when the tags changed.
 */
export function canonicalizeNoteTags(state: CollectionState, note: Note): boolean {
  const winners = winningAddedTags(state, note.id);
  if (winners.length === 0) return false;
  const added = new Set(winners);
  const next = [...note.tags.filter((t) => !added.has(normalizeAddedTag(t))), ...winners];
  const same = next.length === note.tags.length && next.every((t, i) => t === note.tags[i]);
  if (same) return false;
  note.tags = next;
  return true;
}

/** True when the note has any add register (cheap pre-check before {@link canonicalizeNoteTags}). */
export function noteHasTagAdds(state: CollectionState, noteId: string): boolean {
  return (tagAddIndex(state).get(noteId)?.size ?? 0) > 0;
}
