import type { CollectionState, SourceKind } from '@flash/core';
import type { SourcesRegistry } from '@flash/platform';

/** Deck source kinds the registry rebuilds a row for from synced decks (`loadSourcesRegistry`). */
const SYNCED_DECK_SOURCE_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>([
  'google_sheets',
  'onedrive_file',
  'google_drive_file',
  'dropbox_file',
  'package_url',
]);

/**
 * True when a deck or page synced from another device carries a linked source this device would
 * refresh: `loadSourcesRegistry` adds its row even when Sources was never opened here.
 */
function hasSyncedLinkedSource(state: CollectionState): boolean {
  for (const deck of state.decks.values()) {
    if (deck.archived || !deck.source || !SYNCED_DECK_SOURCE_KINDS.has(deck.source.kind)) continue;
    if (deck.source.kind === 'package_url' ? deck.source.uri : deck.source.external_id) return true;
  }
  for (const page of state.pages.values()) {
    if (page.source?.kind === 'google_docs' && page.source.external_id) return true;
  }
  return false;
}

/**
 * The launch check (§8): true when the saved registry lists any linked source, or (with `state`)
 * a synced deck or page carries one, so the app loads `sourceRunner` after first paint only then.
 * Tolerates registries saved before a list existed.
 */
export function hasLinkedSources(
  saved: Partial<SourcesRegistry> | undefined,
  state?: CollectionState,
): boolean {
  return (
    Boolean(saved?.googleSources?.length) ||
    Boolean(saved?.oneDriveSources?.length) ||
    Boolean(saved?.dropboxSources?.length) ||
    Boolean(saved?.googleDriveFiles?.length) ||
    Boolean(saved?.localFolders?.length) ||
    Boolean(saved?.packageSubscriptions?.length) ||
    Boolean(saved?.catalogs?.length) ||
    (state !== undefined && hasSyncedLinkedSource(state))
  );
}
