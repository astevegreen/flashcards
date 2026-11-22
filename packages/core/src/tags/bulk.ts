import { isCardSuspended, type CollectionState, type EventFactory } from '../events/replay.ts';
import type { EventPayloadMap, KnownEvent } from '../events/types.ts';
import type { Deck, Note } from '../model/types.ts';
import {
  isTagInSubtree,
  normalizeTagList,
  normalizeTagText,
  tagKey,
  validateTagName,
} from './index.ts';

/**
 * Browse bulk edit (Phase 9): pure planners that turn a selection of notes plus one action
 * into the events to append as a single batch. Notes that would not change are skipped, so
 * re-running an action is a no-op.
 */

export type BulkEventType =
  'NoteUpserted' | 'NoteArchived' | 'NoteRestored' | 'CardSuspended' | 'CardUnsuspended';

export type BulkEventDraft = {
  [K in BulkEventType]: { type: K; payload: EventPayloadMap[K] };
}[BulkEventType];

export type BulkNoteAction =
  | { kind: 'add_tags'; tags: readonly string[] }
  /** Removes each category and its `::` descendants (same matching as the filter). */
  | { kind: 'remove_tags'; tags: readonly string[] }
  | { kind: 'move_deck'; deckId: string }
  | { kind: 'archive' }
  | { kind: 'restore' }
  | { kind: 'suspend' }
  | { kind: 'unsuspend' };

export type BulkActionError =
  | { code: 'invalid_tag'; tag: string }
  | { code: 'unknown_deck' }
  /** The target deck uses another note type: card ids (and so schedules) would not carry over. */
  | { code: 'note_type_mismatch'; noteIds: string[] }
  /**
   * The note's deck (or the target) is linked to a source (Sheet, folder, package) that would
   * re-create or move the note back on its next pull.
   */
  | { code: 'source_linked'; noteIds: string[] }
  /**
   * The note's `source_key` (its Card ID / package record id) is already used by another note
   * in the target deck, or by another moved note. A deck's CSV and `.flashpkg` round trips
   * identify notes by `source_key`, so two notes sharing one would collapse into one on import.
   */
  | { code: 'source_key_conflict'; noteIds: string[] };

export interface BulkActionPlan {
  events: BulkEventDraft[];
  /** Selected notes the plan changes. */
  changedNoteCount: number;
  error?: BulkActionError;
}

function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function selectedNotes(state: CollectionState, noteIds: Iterable<string>): Note[] {
  const out: Note[] = [];
  for (const id of new Set(noteIds)) {
    const note = state.notes.get(id);
    if (note) out.push(note);
  }
  return out.sort((a, b) => cmpStr(a.id, b.id));
}

function tagsPayload(note: Note, tags: string[]): BulkEventDraft {
  return {
    type: 'NoteUpserted',
    payload: {
      note_id: note.id,
      deck_id: note.deck_id,
      source_key: note.source_key,
      fields: {},
      tags,
    },
  };
}

/**
 * True for decks fed by a source (Google Sheet / Doc, local folder file, `.flashpkg` package
 * or package URL). Their next pull re-creates or moves a moved note back, so Browse doesn't
 * move notes into or out of them. Decks made in the app (`native`) are not linked.
 */
export function isLinkedDeck(deck: Deck | undefined): boolean {
  return deck?.source !== undefined && deck.source.kind !== 'native';
}

/** Decks a note can move to without losing its cards: same note type, not archived, not linked. */
export function listMoveTargetDecks(state: CollectionState, noteTypeId: string): string[] {
  return [...state.decks.values()]
    .filter((d) => !d.archived && !isLinkedDeck(d) && d.note_type_id === noteTypeId)
    .map((d) => d.id)
    .sort(cmpStr);
}

/**
 * Moving notes whose non-empty `source_key` is already taken in the target deck (by any note,
 * archived ones included, since imports match those too) or by another moving note.
 */
function sourceKeyConflicts(
  state: CollectionState,
  notes: readonly Note[],
  targetDeckId: string,
): string[] {
  const moving = notes.filter((n) => n.deck_id !== targetDeckId);
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const note of state.notes.values()) {
    if (note.deck_id === targetDeckId && note.source_key) bump(note.source_key);
  }
  for (const note of moving) if (note.source_key) bump(note.source_key);
  return moving.filter((n) => n.source_key && (counts.get(n.source_key) ?? 0) > 1).map((n) => n.id);
}

export function planBulkNoteAction(
  state: CollectionState,
  noteIds: Iterable<string>,
  action: BulkNoteAction,
): BulkActionPlan {
  const notes = selectedNotes(state, noteIds);
  switch (action.kind) {
    case 'add_tags':
      return planAddTags(notes, action.tags);
    case 'remove_tags':
      return planRemoveTags(notes, action.tags);
    case 'move_deck':
      return planMoveDeck(state, notes, action.deckId);
    case 'archive':
    case 'restore':
      return planArchive(notes, action.kind === 'archive');
    case 'suspend':
    case 'unsuspend':
      return planSuspension(state, notes, action.kind === 'suspend');
  }
}

function refused(error: BulkActionError): BulkActionPlan {
  return { events: [], changedNoteCount: 0, error };
}

/** One event per note whose `next` tags differ from its current ones. */
function planTagRewrite(
  notes: readonly Note[],
  rewrite: (note: Note) => string[] | undefined,
): BulkActionPlan {
  const events: BulkEventDraft[] = [];
  for (const note of notes) {
    const next = rewrite(note);
    if (next) events.push(tagsPayload(note, next));
  }
  return { events, changedNoteCount: events.length };
}

function planAddTags(notes: readonly Note[], tags: readonly string[]): BulkActionPlan {
  const invalid = tags.find((tag) => validateTagName(tag));
  if (invalid !== undefined) return refused({ code: 'invalid_tag', tag: invalid });
  const additions = normalizeTagList(tags.map(normalizeTagText));
  return planTagRewrite(notes, (note) => {
    const next = normalizeTagList([...note.tags, ...additions]);
    return sameList(note.tags, next) ? undefined : next;
  });
}

function planRemoveTags(notes: readonly Note[], tags: readonly string[]): BulkActionPlan {
  const keys = [...new Set(tags.map(tagKey).filter((k) => k.length > 0))];
  return planTagRewrite(notes, (note) => {
    const kept = note.tags.filter((t) => !keys.some((k) => isTagInSubtree(tagKey(t), k)));
    return kept.length === note.tags.length ? undefined : normalizeTagList(kept);
  });
}

/** Why the selection can't move into `deck`, if it can't. */
function moveDeckError(
  state: CollectionState,
  notes: readonly Note[],
  deck: Deck,
): BulkActionError | undefined {
  const linked = notes
    .filter((n) => n.deck_id !== deck.id)
    .filter((n) => isLinkedDeck(deck) || isLinkedDeck(state.decks.get(n.deck_id)))
    .map((n) => n.id);
  if (linked.length > 0) return { code: 'source_linked', noteIds: linked };
  const mismatched = notes
    .filter((n) => state.decks.get(n.deck_id)?.note_type_id !== deck.note_type_id)
    .map((n) => n.id);
  if (mismatched.length > 0) return { code: 'note_type_mismatch', noteIds: mismatched };
  const conflicts = sourceKeyConflicts(state, notes, deck.id);
  if (conflicts.length > 0) return { code: 'source_key_conflict', noteIds: conflicts };
  return undefined;
}

function planMoveDeck(
  state: CollectionState,
  notes: readonly Note[],
  deckId: string,
): BulkActionPlan {
  const deck = state.decks.get(deckId);
  if (!deck || deck.archived) return refused({ code: 'unknown_deck' });
  const error = moveDeckError(state, notes, deck);
  if (error) return refused(error);
  // The moved note keeps its id (and so its cards and schedules), which was derived from
  // its old deck. Imports into the new deck find it by `source_key`, not by derived id.
  const events: BulkEventDraft[] = notes
    .filter((note) => note.deck_id !== deck.id)
    .map((note) => ({
      type: 'NoteUpserted',
      payload: { note_id: note.id, deck_id: deck.id, source_key: note.source_key, fields: {} },
    }));
  return { events, changedNoteCount: events.length };
}

function planArchive(notes: readonly Note[], archive: boolean): BulkActionPlan {
  const events: BulkEventDraft[] = notes
    .filter((note) => note.archived !== archive)
    .map((note) =>
      archive
        ? { type: 'NoteArchived', payload: { note_id: note.id } }
        : { type: 'NoteRestored', payload: { note_id: note.id } },
    );
  return { events, changedNoteCount: events.length };
}

function planSuspension(
  state: CollectionState,
  notes: readonly Note[],
  suspend: boolean,
): BulkActionPlan {
  const events: BulkEventDraft[] = [];
  let changedNoteCount = 0;
  for (const note of notes) {
    const cardIds = [...(state.cardIdsByNote.get(note.id) ?? [])]
      .sort(cmpStr)
      .filter((cardId) => isCardSuspended(state, cardId) !== suspend);
    for (const cardId of cardIds) {
      events.push(
        suspend
          ? { type: 'CardSuspended', payload: { card_id: cardId } }
          : { type: 'CardUnsuspended', payload: { card_id: cardId } },
      );
    }
    if (cardIds.length > 0) changedNoteCount += 1;
  }
  return { events, changedNoteCount };
}

/** Turns planned drafts into events (one batch, one timestamp). */
export function createBulkEvents(
  factory: EventFactory,
  drafts: readonly BulkEventDraft[],
  nowMs: number,
): KnownEvent[] {
  return drafts.map((d) => {
    switch (d.type) {
      case 'NoteUpserted':
        return factory.create(d.type, d.payload, nowMs);
      case 'NoteArchived':
        return factory.create(d.type, d.payload, nowMs);
      case 'NoteRestored':
        return factory.create(d.type, d.payload, nowMs);
      case 'CardSuspended':
        return factory.create(d.type, d.payload, nowMs);
      case 'CardUnsuspended':
        return factory.create(d.type, d.payload, nowMs);
    }
  });
}
