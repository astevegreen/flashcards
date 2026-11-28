// @vitest-environment happy-dom
// The Library's one-time offer to set a Sentence deck's language from its text: taking it writes
// a DeckSettingsChanged (and Undo another), keeping the current language writes only the record,
// and neither ever shows the offer again.
import {
  BUILTIN_NOTE_TYPE_IDS,
  createEventFactory,
  createHlcState,
  type FlashEvent,
} from '@flash/core';
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryScreen } from '../src/screens/LibraryScreen.tsx';
import { createSyncStateStore, SyncStateContext } from '../src/state/syncStateStore.ts';
import type { SyncUiState } from '../src/state/useSyncController.ts';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  type Mounted,
} from './helpers/app-harness.tsx';

const T0 = Date.UTC(2026, 10, 1);

function linkedSentenceDeck(language: string): FlashEvent[] {
  const f = createEventFactory('other', 0, createHlcState('other', T0));
  return [
    f.create(
      'DeckCreated',
      {
        deck_id: 'old-link',
        name: 'Sheet sentences',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.SENTENCE,
        language,
      },
      T0,
    ),
    f.create(
      'NoteUpserted',
      {
        note_id: 'n1',
        deck_id: 'old-link',
        source_key: 'r1',
        fields: { sentence: '저는 학생이에요.', translation: 'I am a student.' },
      },
      T0 + 1,
    ),
  ];
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function mountLibrary(readOnly = false, language = 'en-US') {
  const storage = createMemoryStorage();
  const library = createElement(LibraryScreen, { onStudyDeck: () => undefined });
  // A read-only sync state (a newer-format collection) for the inner tree only.
  const ui = readOnly
    ? createElement(
        SyncStateContext.Provider,
        {
          value: createSyncStateStore({
            provider: 'none',
            status: 'upgrade_required',
            readOnly: true,
          } as SyncUiState),
        },
        library,
      )
    : library;
  mounted = await mountWithApp(ui, {
    platform: createTestPlatform(storage),
    initialEvents: linkedSentenceDeck(language),
  });
  const m = mounted;
  const find = (id: string) =>
    m.container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  const waitFor = (id: string) =>
    vi.waitFor(async () => {
      await flush(1);
      expect(find(id)).not.toBeNull();
    });
  const appendedTypes = () => storage.appended.flat().map((e) => e.type);
  return { m, find, waitFor, appendedTypes };
}

describe('Library deck language offer', () => {
  it('sets the language by event, offers Undo, and does not ask again', async () => {
    const { m, find, waitFor, appendedTypes } = await mountLibrary();
    await waitFor('deck-language-offer-old-link');
    expect(find('deck-language-offer-old-link')?.textContent).toContain('looks Korean');

    await act(async () => find('deck-language-accept-old-link')?.click());
    await flush();
    expect(m.app().state.decks.get('old-link')?.language).toBe('ko');
    expect(appendedTypes()).toEqual(['DeckSettingsChanged', 'DeckLanguageOffered']);
    expect(find('deck-language-offer-old-link')).toBeNull();

    await waitFor('deck-language-undo-old-link');
    await act(async () => find('deck-language-undo-old-link')?.click());
    await flush();
    expect(m.app().state.decks.get('old-link')?.language).toBe('en-US');
    expect(appendedTypes().at(-1)).toBe('DeckSettingsChanged');
    expect(find('deck-language-changed-old-link')).toBeNull();
    expect(find('deck-language-offer-old-link')).toBeNull();
  });

  it('keeping the language records the answer only, and the offer is gone', async () => {
    const { m, find, waitFor, appendedTypes } = await mountLibrary();
    await waitFor('deck-language-dismiss-old-link');
    await act(async () => find('deck-language-dismiss-old-link')?.click());
    await flush();
    expect(appendedTypes()).toEqual(['DeckLanguageOffered']);
    expect(m.app().state.decks.get('old-link')?.language).toBe('en-US');
    expect(find('deck-language-offer-old-link')).toBeNull();
  });

  it('shows no offer while the collection is read-only', async () => {
    const { m, find, appendedTypes } = await mountLibrary(true);
    await flush(3);
    expect(m.container.querySelector('[data-testid^="deck-language"]')).toBeNull();
    expect(find('deck-language-offer-old-link')).toBeNull();
    expect(appendedTypes()).toEqual([]);
  });

  it('names the languages in words, not tags', async () => {
    const { find, waitFor } = await mountLibrary();
    await waitFor('deck-language-offer-old-link');
    const text = find('deck-language-offer-old-link')?.textContent ?? '';
    expect(text).toContain('its language is English');
    expect(text).not.toContain('en-US');
  });

  it('Close hides the Undo banner without changing the language', async () => {
    const { m, find, waitFor, appendedTypes } = await mountLibrary();
    await waitFor('deck-language-accept-old-link');
    await act(async () => find('deck-language-accept-old-link')?.click());
    await flush();
    await waitFor('deck-language-changed-old-link');
    const close = [
      ...(find('deck-language-changed-old-link')?.querySelectorAll('button') ?? []),
    ].find((b) => b.textContent === 'Close');
    await act(async () => close?.click());
    await flush();
    expect(find('deck-language-changed-old-link')).toBeNull();
    expect(find('deck-language-offer-old-link')).toBeNull();
    expect(m.app().state.decks.get('old-link')?.language).toBe('ko');
    expect(appendedTypes()).toEqual(['DeckSettingsChanged', 'DeckLanguageOffered']);
  });

  it('reads an empty language as "no language"', async () => {
    const { find, waitFor } = await mountLibrary(false, '');
    await waitFor('deck-language-offer-old-link');
    expect(find('deck-language-offer-old-link')?.textContent).toContain(
      'its language is no language',
    );
  });

  it('names a language outside the app list through Intl.DisplayNames', async () => {
    const { find, waitFor } = await mountLibrary(false, 'fr');
    await waitFor('deck-language-offer-old-link');
    expect(find('deck-language-offer-old-link')?.textContent).toContain('its language is French');
  });
});
