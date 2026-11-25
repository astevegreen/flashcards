import type { CollectionState, Deck } from '@flash/core';

/**
 * The active deck a Dropbox App Folder file is linked to, if any (its note type then can't change).
 * Archived decks don't count: linking again would not show up anywhere.
 */
export function linkedDropboxDeck(state: CollectionState, fileId: string): Deck | undefined {
  for (const deck of state.decks.values()) {
    if (
      !deck.archived &&
      deck.source?.kind === 'dropbox_file' &&
      deck.source.external_id === fileId
    ) {
      return deck;
    }
  }
  return undefined;
}
