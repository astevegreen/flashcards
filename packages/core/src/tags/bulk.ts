import { isCardSuspended, type CollectionState } from '../events/replay.ts';
import type { EventPayloadMap } from '../events/types.ts';
import type { Note } from '../model/types.ts';
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
  | { code: 'source_linked'; noteIds: string[] };

export interface BulkActionPlan {
  events: BulkEventDraft[];
  /** Selected notes the plan changes. */
  changedNoteCount: number;
  error?: BulkActionError;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

/** Decks a note can move to without losing its cards: same note type, not archived, not linked. */
export function listMoveTargetDecks(state: CollectionState, noteTypeId: string): string[] {
  return [...state.decks.values()]
    .filter((d) => !d.archived && d.source === undefined && d.note_type_id === noteTypeId)
    .map((d) => d.id)
    .sort(cmpStr);
}

export function planBulkNoteAction(
  state: CollectionState,
  noteIds: Iterable<string>,
  action: BulkNoteAction,
): BulkActionPlan {
  const notes = selectedNotes(state, noteIds);
  const events: BulkEventDraft[] = [];
  let changedNoteCount = 0;

  switch (action.kind) {
    case 'add_tags': {
      for (const tag of action.tags) {
        if (validateTagName(tag)) {
          return { events: [], changedNoteCount: 0, error: { code: 'invalid_tag', tag } };
        }
      }
      const additions = normalizeTagList(action.tags.map(normalizeTagText));
      for (const note of notes) {
        const next = normalizeTagList([...note.tags, ...additions]);
        if (sameList(note.tags, next)) continue;
        events.push(tagsPayload(note, next));
        changedNoteCount += 1;
      }
      break;
    }
    case 'remove_tags': {
      const keys = [...new Set(action.tags.map(tagKey).filter((k) => k.length > 0))];
      for (const note of notes) {
        const kept = note.tags.filter((t) => !keys.some((k) => isTagInSubtree(tagKey(t), k)));
        if (kept.length === note.tags.length) continue;
        events.push(tagsPayload(note, normalizeTagList(kept)));
        changedNoteCount += 1;
      }
      break;
    }
    case 'move_deck': {
      const deck = state.decks.get(action.deckId);
      if (!deck || deck.archived) {
        return { events: [], changedNoteCount: 0, error: { code: 'unknown_deck' } };
      }
      const linked = notes
        .filter((n) => n.deck_id !== deck.id)
        .filter(
          (n) => deck.source !== undefined || state.decks.get(n.deck_id)?.source !== undefined,
        )
        .map((n) => n.id);
      if (linked.length > 0) {
        return {
          events: [],
          changedNoteCount: 0,
          error: { code: 'source_linked', noteIds: linked },
        };
      }
      const mismatched = notes
        .filter((n) => state.decks.get(n.deck_id)?.note_type_id !== deck.note_type_id)
        .map((n) => n.id);
      if (mismatched.length > 0) {
        return {
          events: [],
          changedNoteCount: 0,
          error: { code: 'note_type_mismatch', noteIds: mismatched },
        };
      }
      for (const note of notes) {
        if (note.deck_id === deck.id) continue;
        events.push({
          type: 'NoteUpserted',
          payload: { note_id: note.id, deck_id: deck.id, source_key: note.source_key, fields: {} },
        });
        changedNoteCount += 1;
      }
      break;
    }
    case 'archive':
    case 'restore': {
      const archive = action.kind === 'archive';
      for (const note of notes) {
        if (note.archived === archive) continue;
        events.push(
          archive
            ? { type: 'NoteArchived', payload: { note_id: note.id } }
            : { type: 'NoteRestored', payload: { note_id: note.id } },
        );
        changedNoteCount += 1;
      }
      break;
    }
    case 'suspend':
    case 'unsuspend': {
      const suspend = action.kind === 'suspend';
      for (const note of notes) {
        const cardIds = [...(state.cardIdsByNote.get(note.id) ?? [])].sort(cmpStr);
        let changed = false;
        for (const cardId of cardIds) {
          if (isCardSuspended(state, cardId) === suspend) continue;
          events.push(
            suspend
              ? { type: 'CardSuspended', payload: { card_id: cardId } }
              : { type: 'CardUnsuspended', payload: { card_id: cardId } },
          );
          changed = true;
        }
        if (changed) changedNoteCount += 1;
      }
      break;
    }
  }
  return { events, changedNoteCount };
}
