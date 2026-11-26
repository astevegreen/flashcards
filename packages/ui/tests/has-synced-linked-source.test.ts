import { createEmptyState, type CollectionState, type SourceRef } from '@flash/core';
import { describe, expect, it } from 'vitest';
import { hasSyncedLinkedSource } from '../src/sources/hasSyncedLinkedSource.ts';

function withDeck(source: Partial<SourceRef> | undefined, archived = false): CollectionState {
  const state = createEmptyState();
  state.decks.set('deck-1', { id: 'deck-1', name: 'Deck', archived, source } as never);
  return state;
}

describe('hasSyncedLinkedSource (launch check for synced linked decks)', () => {
  it('is false for an empty collection or decks without a refreshable source', () => {
    expect(hasSyncedLinkedSource(createEmptyState())).toBe(false);
    expect(hasSyncedLinkedSource(withDeck(undefined))).toBe(false);
    expect(hasSyncedLinkedSource(withDeck({ kind: 'local_file', external_id: 'x' }))).toBe(false);
  });

  it.each(['google_sheets', 'onedrive_file', 'google_drive_file', 'dropbox_file'] as const)(
    'is true for a %s deck with an external id, false without one or when archived',
    (kind) => {
      expect(hasSyncedLinkedSource(withDeck({ kind, external_id: 'f1' }))).toBe(true);
      expect(hasSyncedLinkedSource(withDeck({ kind }))).toBe(false);
      expect(hasSyncedLinkedSource(withDeck({ kind, external_id: 'f1' }, true))).toBe(false);
    },
  );

  it('checks a package_url deck by its uri, not its external id', () => {
    expect(hasSyncedLinkedSource(withDeck({ kind: 'package_url', uri: 'https://x/p' }))).toBe(true);
    expect(hasSyncedLinkedSource(withDeck({ kind: 'package_url', external_id: 'p' }))).toBe(false);
  });

  it('is true for a page linked to a Google Doc', () => {
    const state = createEmptyState();
    state.pages.set('page-1', {
      id: 'page-1',
      title: 'Notes',
      source: { kind: 'google_docs', external_id: 'doc-1' },
    } as never);
    expect(hasSyncedLinkedSource(state)).toBe(true);
    state.pages.set('page-1', {
      id: 'page-1',
      title: 'Notes',
      source: { kind: 'google_docs' },
    } as never);
    expect(hasSyncedLinkedSource(state)).toBe(false);
  });

  it('skips OneDrive files this device unlinked with an older build', () => {
    const state = withDeck({ kind: 'onedrive_file', external_id: 'item-1' });
    expect(hasSyncedLinkedSource(state, { unlinkedOneDriveIds: ['item-1'] })).toBe(false);
    expect(hasSyncedLinkedSource(state, { unlinkedOneDriveIds: ['other'] })).toBe(true);
    // Only OneDrive rows use that list.
    const dropbox = withDeck({ kind: 'dropbox_file', external_id: 'item-1' });
    expect(hasSyncedLinkedSource(dropbox, { unlinkedOneDriveIds: ['item-1'] })).toBe(true);
  });
});
