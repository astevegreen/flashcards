import type { CollectionState, Deck } from '@flash/core';

/**
 * The active deck a OneDrive file is linked to, if any (its note type then can't change).
 * Archived decks don't count: linking again would not show up anywhere.
 */
export function linkedOneDriveDeck(state: CollectionState, itemId: string): Deck | undefined {
  for (const deck of state.decks.values()) {
    if (
      !deck.archived &&
      deck.source?.kind === 'onedrive_file' &&
      deck.source.external_id === itemId
    ) {
      return deck;
    }
  }
  return undefined;
}
