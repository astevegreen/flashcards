import type { CollectionState, SourceKind } from '@flash/core';

/** Deck source kinds the registry rebuilds a row for from synced decks (`loadSourcesRegistry`). */
const SYNCED_DECK_SOURCE_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>([
  'google_sheets',
  'onedrive_file',
  'google_drive_file',
  'dropbox_file',
  'package_url',
]);

/**
 * The second half of the launch check (§8), loaded only when the saved registry is empty: true
 * when a deck or page synced from another device carries a linked source this device would
 * refresh, since `loadSourcesRegistry` adds its row even when Sources was never opened here.
 */
export function hasSyncedLinkedSource(state: CollectionState): boolean {
  for (const deck of state.decks.values()) {
    if (deck.archived || !deck.source || !SYNCED_DECK_SOURCE_KINDS.has(deck.source.kind)) continue;
    if (deck.source.kind === 'package_url' ? deck.source.uri : deck.source.external_id) return true;
  }
  for (const page of state.pages.values()) {
    if (page.source?.kind === 'google_docs' && page.source.external_id) return true;
  }
  return false;
}
