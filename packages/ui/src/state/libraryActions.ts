import {
  FLASH_NAMESPACE_UUID,
  getActiveFsrsParamsVersion,
  getEnabledLayoutsForDeck,
  resolveDeckFsrsConfig,
  uuidv5,
  uuidv7,
  type Course,
  type KnownEvent,
  type Layout,
} from '@flash/core';
import { useMemo } from 'react';
import { useApp, type AppContextValue } from './AppContext.tsx';

/**
 * Deck, layout, page and course edits. Only Library, Pages, Courses and the import panels use
 * them, so they live here instead of in AppContext, which the study screen loads (§8). Each one
 * reads the live collection and appends its events through `emitEvents`, as AppContext's own do.
 */
export interface LibraryActions {
  upsertLayout: (layout: Layout, enableOnDeckId?: string) => void;
  upsertPage: (input: {
    pageId?: string;
    slug: string;
    title: string;
    markdown: string;
    lang?: string;
    tags: string[];
  }) => string;
  markPageRead: (pageId: string) => void;
  upsertCourse: (course: Course) => void;
  createDeck: (name: string, noteTypeId: string, language: string) => string;
  toggleDeckLayout: (deckId: string, layoutId: string) => void;
  /** Re-applies the deck's current FSRS params to every past review (§4.1 explicit reschedule). */
  rescheduleDeck: (deckId: string) => void;
}

type LibraryActionsApp = Pick<
  AppContextValue,
  'getEventFactory' | 'getState' | 'emitEvents' | 'updateDeckSettings'
>;

export function createLibraryActions(app: LibraryActionsApp): LibraryActions {
  const { getEventFactory, getState, emitEvents, updateDeckSettings } = app;
  return {
    upsertLayout(layout, enableOnDeckId) {
      const factory = getEventFactory();
      const st = getState();
      const nowMs = Date.now();
      const events: KnownEvent[] = [factory.create('LayoutChanged', { layout }, nowMs)];
      const deck = enableOnDeckId ? st.decks.get(enableOnDeckId) : undefined;
      if (enableOnDeckId && deck) {
        const currentEnabled = getEnabledLayoutsForDeck(st, deck).map((l) => l.id);
        if (!currentEnabled.includes(layout.id)) {
          events.push(
            factory.create(
              'DeckSettingsChanged',
              {
                deck_id: enableOnDeckId,
                settings: { enabled_layout_ids: [...currentEnabled, layout.id] },
              },
              nowMs,
            ),
          );
        }
      }
      emitEvents(events);
    },

    upsertPage(input) {
      const factory = getEventFactory();
      const nowMs = Date.now();
      const cleanSlug =
        input.slug
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af-]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'page';
      const pageId =
        input.pageId ?? uuidv5(FLASH_NAMESPACE_UUID, `page:native:${cleanSlug}:${uuidv7(nowMs)}`);
      const ev = factory.create(
        'PageUpserted',
        {
          page_id: pageId,
          slug: cleanSlug,
          title: input.title.trim() || cleanSlug,
          markdown: input.markdown,
          ...(input.lang ? { lang: input.lang } : {}),
          tags: input.tags,
          source: { kind: 'native', last_synced_at: nowMs },
        },
        nowMs,
      );
      emitEvents([ev]);
      return pageId;
    },

    markPageRead(pageId) {
      const nowMs = Date.now();
      emitEvents([
        getEventFactory().create('PageRead', { page_id: pageId, read_at: nowMs }, nowMs),
      ]);
    },

    upsertCourse(course) {
      emitEvents([getEventFactory().create('CourseChanged', { course }, Date.now())]);
    },

    createDeck(name, noteTypeId, language) {
      const factory = getEventFactory();
      const nowMs = Date.now();
      const deckId = uuidv5(FLASH_NAMESPACE_UUID, `${name}:${nowMs}:${uuidv7(nowMs)}`);
      const ev = factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: name.trim(),
          note_type_id: noteTypeId,
          language,
          source: { kind: 'native' },
          created_at: nowMs,
        },
        nowMs,
      );
      emitEvents([ev]);
      return deckId;
    },

    toggleDeckLayout(deckId, layoutId) {
      const st = getState();
      const deck = st.decks.get(deckId);
      if (!deck) return;
      const currentEnabled = getEnabledLayoutsForDeck(st, deck).map((l) => l.id);
      let nextIds: string[];
      if (currentEnabled.includes(layoutId)) {
        if (currentEnabled.length <= 1) return; // Always keep at least 1 layout active
        nextIds = currentEnabled.filter((id) => id !== layoutId);
      } else {
        nextIds = [...currentEnabled, layoutId];
      }
      updateDeckSettings(deckId, { settings: { enabled_layout_ids: nextIds } });
    },

    rescheduleDeck(deckId) {
      const factory = getEventFactory();
      const st = getState();
      const deck = st.decks.get(deckId);
      if (!deck) return;
      const nowMs = Date.now();
      const current = resolveDeckFsrsConfig(st, deckId, nowMs);
      const ev = factory.create(
        'DeckFSRSParamsChanged',
        {
          deck_id: deckId,
          params_version: getActiveFsrsParamsVersion(st, deckId) + 1,
          effective_from: nowMs,
          params: { ...current, request_retention: deck.settings.target_retention },
          reschedule_existing: true,
        },
        nowMs,
      );
      emitEvents([ev]);
    },
  };
}

/** {@link LibraryActions} bound to the app; a new set only when `emitEvents` changes. */
export function useLibraryActions(): LibraryActions {
  const { getEventFactory, getState, emitEvents, updateDeckSettings } = useApp();
  return useMemo(
    () => createLibraryActions({ getEventFactory, getState, emitEvents, updateDeckSettings }),
    [getEventFactory, getState, emitEvents, updateDeckSettings],
  );
}
