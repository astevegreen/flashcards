import type { CollectionState, SourceKind, SourceRef } from '@flash/core';
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
 * The second half of the launch check (§8), loaded only when the saved registry lists no source:
 * true when a deck or page synced from another device carries a linked source this device would
 * refresh, since `loadSourcesRegistry` adds its row even when Sources was never opened here. Like
 * that merge, it skips archived decks and OneDrive files unlinked here by an older build
 * (`unlinkedOneDriveIds`). Rows `dropSourcesUnlinkedElsewhere` removes are saved rows whose deck
 * no longer carries the source, so a deck that still carries one is never among them.
 */
export function hasSyncedLinkedSource(
  state: CollectionState,
  saved?: Partial<SourcesRegistry>,
): boolean {
  const unlinkedOneDrive = new Set(saved?.unlinkedOneDriveIds ?? []);
  for (const deck of state.decks.values()) {
    if (!deck.archived && deck.source && rebuildsRow(deck.source, unlinkedOneDrive)) return true;
  }
  for (const page of state.pages.values()) {
    if (page.source?.kind === 'google_docs' && page.source.external_id) return true;
  }
  return false;
}

/** True when `loadSourcesRegistry` would add a row for a deck carrying `src`. */
function rebuildsRow(src: SourceRef, unlinkedOneDrive: ReadonlySet<string>): boolean {
  if (!SYNCED_DECK_SOURCE_KINDS.has(src.kind)) return false;
  if (src.kind === 'package_url') return Boolean(src.uri);
  if (!src.external_id) return false;
  return src.kind !== 'onedrive_file' || !unlinkedOneDrive.has(src.external_id);
}
