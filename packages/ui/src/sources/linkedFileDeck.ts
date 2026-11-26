import type { CollectionState, Deck, SourceKind } from '@flash/core';

/**
 * The active deck a linked cloud file (OneDrive, Dropbox or Google Drive) fills, if any: its note
 * type then can't change. Archived decks don't count: linking again would not show up anywhere.
 */
export function linkedFileDeck(
  state: CollectionState,
  kind: SourceKind,
  fileId: string,
): Deck | undefined {
  for (const deck of state.decks.values()) {
    if (!deck.archived && deck.source?.kind === kind && deck.source.external_id === fileId) {
      return deck;
    }
  }
  return undefined;
}
