import type { EventPayloadMap, UnknownEvent } from './types.ts';
import { hasOptionalCardRules } from '../model/optional-cards.ts';
import {
  applyMediaRemoved,
  applySourceUnlinkedAt,
  getEnabledLayoutsForDeck,
  planNoteCards,
  rebuildCardsForNote,
  ruleLayoutsForDeck,
  type CollectionState,
} from './replay.ts';
import { applySuspensionRegister, isSuspensionEventType } from './suspension.ts';
import {
  applyTagAddRegisters,
  canonicalizeNoteTags,
  NOTE_TAGS_ADDED,
  tagAddIndex,
} from './tag-adds.ts';

/*
 * Snapshot hydration upgrades (older snapshot formats). Only `snapshot.ts` uses them, so they live
 * here instead of in `replay.ts`, `suspension.ts` and `tag-adds.ts`, which the study screen needs:
 * that keeps them out of the initial study-screen chunk (§8).
 */

/**
 * Re-derives, after snapshot hydration, the cards of every note in a deck with a rule layout
 * whose stored cards differ from what replay would derive. A snapshot saved by a build that
 * predates optional cards keeps a synced `required_field` on the layout but derived every card;
 * this makes hydrating it equal to a full replay. Snapshots of this build already match, so the
 * pass only compares card ids and `empty` flags. No-op when no layout has a rule.
 */
export function canonicalizeOptionalCards(state: CollectionState): void {
  if (!hasOptionalCardRules(state.layouts.values())) return;
  const sets = {
    replayedCards: new Set<string>(),
    changedCards: new Set<string>(),
    removedCards: new Set<string>(),
  };
  for (const deck of state.decks.values()) {
    if (deck.archived || ruleLayoutsForDeck(state, deck).length === 0) continue;
    const enabledLayouts = getEnabledLayoutsForDeck(state, deck);
    for (const noteId of state.noteIdsByDeck.get(deck.id) ?? []) {
      const note = state.notes.get(noteId);
      if (!note || note.archived || note.deck_id !== deck.id) continue;
      const planned = planNoteCards(state, note, enabledLayouts);
      const stored = state.cardIdsByNote.get(note.id);
      const matches =
        (stored?.size ?? 0) === planned.length &&
        planned.every(
          (p) =>
            stored?.has(p.cardId) === true &&
            (state.cards.get(p.cardId)?.empty === true) === p.empty,
        );
      if (!matches) {
        rebuildCardsForNote(
          state,
          note.id,
          sets.changedCards,
          sets.removedCards,
          sets.replayedCards,
        );
      }
    }
  }
}

/**
 * Upgrade path for snapshots written by builds that predate `SourceUnlinked`: they kept those
 * events in `unknownEvents` (below the snapshot watermark, never replayed again). Applies them
 * and returns the events that remain unknown.
 */
export function foldSourceUnlinkedFromUnknown(
  state: CollectionState,
  unknownEvents: readonly UnknownEvent[],
): UnknownEvent[] {
  const remaining: UnknownEvent[] = [];
  for (const ev of unknownEvents) {
    if (ev.type === 'SourceUnlinked') {
      applySourceUnlinkedAt(state, ev.payload, ev.hlc);
    } else {
      remaining.push(ev);
    }
  }
  return remaining;
}

/** Applies `MediaRemoved` events a snapshot from an older build kept as unknown. */
export function foldMediaRemovedFromUnknown(
  state: CollectionState,
  unknownEvents: readonly UnknownEvent[],
): UnknownEvent[] {
  const remaining: UnknownEvent[] = [];
  for (const ev of unknownEvents) {
    if (ev.type === 'MediaRemoved' && ev.payload !== null && typeof ev.payload === 'object') {
      applyMediaRemoved(
        {
          state,
          hlc: ev.hlc,
          dirtyCards: new Set(),
          dirtyDecks: new Set(),
          dirtyNotes: new Set(),
        },
        ev.payload as EventPayloadMap['MediaRemoved'],
      );
    } else {
      remaining.push(ev);
    }
  }
  return remaining;
}

/**
 * Upgrade path for snapshots written by builds that predate suspension: such builds kept
 * `CardSuspended` / `CardUnsuspended` in `unknownEvents` (their segments are below the snapshot
 * watermark, so they will never be replayed again). Folds them into the registers and returns
 * the events that remain unknown to this build.
 */
export function foldSuspensionEventsFromUnknown(
  fieldHlcs: Map<string, string>,
  unknownEvents: readonly UnknownEvent[],
): UnknownEvent[] {
  const remaining: UnknownEvent[] = [];
  for (const ev of unknownEvents) {
    if (isSuspensionEventType(ev.type)) {
      applySuspensionRegister(fieldHlcs, ev.type, ev.payload, ev.hlc);
    } else {
      remaining.push(ev);
    }
  }
  return remaining;
}

/**
 * Re-derives `note.tags` for every note that has an add register. Hydration runs this because a
 * snapshot written by an older build may carry the registers verbatim in `fieldHlcs` while that
 * build rewrote `note.tags` on a later `NoteUpserted` without knowing the add (newer than the tags
 * register, so it should still show). One pass over the add index.
 */
export function canonicalizeAllTagAddNotes(state: CollectionState): void {
  for (const noteId of tagAddIndex(state).keys()) {
    const note = state.notes.get(noteId);
    if (note) canonicalizeNoteTags(state, note);
  }
}

/**
 * Upgrade path for snapshots written by builds that predate `NoteTagsAdded`: they kept those
 * events in `unknownEvents` (below the snapshot watermark, never replayed again). Folds them into
 * the add registers and the notes' tags, and returns the events that remain unknown.
 */
export function foldTagAddEventsFromUnknown(
  state: CollectionState,
  unknownEvents: readonly UnknownEvent[],
): UnknownEvent[] {
  const remaining: UnknownEvent[] = [];
  const touched = new Set<string>();
  for (const ev of unknownEvents) {
    if (ev.type !== NOTE_TAGS_ADDED) {
      remaining.push(ev);
      continue;
    }
    const applied = applyTagAddRegisters(state, ev.payload, ev.hlc);
    if (applied) touched.add(applied.noteId);
  }
  for (const noteId of touched) {
    const note = state.notes.get(noteId);
    if (note) canonicalizeNoteTags(state, note);
  }
  return remaining;
}
