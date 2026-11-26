import type { CollectionState } from '../events/replay.ts';
import type { DeckSettingsChangedPayload } from '../events/types.ts';
import type { Card, NewCardOrder, StudyOrder } from '../model/types.ts';
import { compareCodeUnits } from '../compare.ts';

/**
 * Study method and card order (Study screen session options, Settings defaults). Every order here
 * is a pure, total comparator: "random" is a seeded hash shuffle, so a queue is identical on every
 * device and on every rebuild for the same seed (a study day, or a practice session id).
 */

/** FNV-1a 32-bit hash: the deterministic source of every seeded order. */
export function hashString32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function cmpId(a: Card, b: Card): number {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/**
 * Seeded shuffle order: by `hash(seed + ':' + card id)`, then card id. The same seed always gives
 * the same relative order, so removing answered cards never reorders the rest.
 */
export function compareSeededRandom(seed: string): (a: Card, b: Card) => number {
  return (a, b) => hashString32(`${seed}:${a.id}`) - hashString32(`${seed}:${b.id}`) || cmpId(a, b);
}

/** Recognition layouts sort before production layouts, then by layout id. */
function compareLayouts(a: string, b: string): number {
  const aIsRec = a.includes('recognition') ? 0 : 1;
  const bIsRec = b.includes('recognition') ? 0 : 1;
  if (aIsRec !== bIsRec) return aIsRec - bIsRec;
  return compareCodeUnits(a, b);
}

/** Source order: by note.created_order, then layout order (Recognition before Production), then variant, then id. */
export function compareSourceOrder(state: CollectionState): (a: Card, b: Card) => number {
  return (a, b) => {
    const oa = state.notes.get(a.note_id)?.created_order ?? 0;
    const ob = state.notes.get(b.note_id)?.created_order ?? 0;
    if (oa !== ob) return oa - ob;
    if (a.layout_id !== b.layout_id) return compareLayouts(a.layout_id, b.layout_id);
    if (a.variant !== b.variant) return a.variant - b.variant;
    return cmpId(a, b);
  };
}

/** The per-deck new-card order a study order stands for. */
export function studyOrderToNewCardOrder(order: StudyOrder): NewCardOrder {
  return order === 'random' ? 'random' : 'source';
}

/** Order of scheduled review cards: the session override, else the synced Settings default. */
export function resolveReviewOrder(
  state: CollectionState,
  override: StudyOrder | undefined,
): StudyOrder {
  return override ?? state.preferences.study_order ?? 'deck';
}

/**
 * Settings "Card order (all decks)": one `DeckSettingsChanged { new_card_order }` per deck whose
 * order differs (deck id order, archived decks included so unarchiving keeps the choice). Each deck
 * stays the source of truth for its new cards, and Library deck options can override it later.
 */
export function planCardOrderForAllDecks(
  state: CollectionState,
  order: StudyOrder,
): DeckSettingsChangedPayload[] {
  const target = studyOrderToNewCardOrder(order);
  return [...state.decks.values()]
    .filter((deck) => deck.settings.new_card_order !== target)
    .map((deck) => deck.id)
    .sort((a, b) => (a < b ? -1 : 1))
    .map((deckId) => ({ deck_id: deckId, settings: { new_card_order: target } }));
}
