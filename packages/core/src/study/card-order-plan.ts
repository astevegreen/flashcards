import type { CollectionState } from '../events/replay.ts';
import type { DeckSettingsChangedPayload } from '../events/types.ts';
import type { StudyOrder } from '../model/types.ts';
import { compareCodeUnits } from '../compare.ts';
import { studyOrderToNewCardOrder } from './card-order.ts';

// Settings-only planning, kept out of card-order.ts so the study queue chunk doesn't carry it (§8).

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
    .sort(compareCodeUnits)
    .map((deckId) => ({ deck_id: deckId, settings: { new_card_order: target } }));
}
