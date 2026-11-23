import {
  buildDeckFolderSavedPayload,
  buildDeckPresetSavedPayload,
  buildPresetParamsPayloads,
  getDeckOrganization,
  getDeckPreset,
  listPresetDeckIds,
  ownSettingsFromPreset,
  presetSeedFromDeck,
  uuidv7,
  type CollectionState,
  type DeckPreset,
  type DeckPresetSettings,
  type EventFactory,
  type KnownEvent,
} from '@flash/core';
import { useMemo } from 'react';
import { useApp } from '../state/AppContext.tsx';

/**
 * Library actions for deck option presets and folders. Every action appends events in one batch:
 * the log-retained organization events plus, where a preset's retention or weights reach a deck,
 * ordinary per-deck `DeckFSRSParamsChanged` events (see `buildPresetParamsPayloads`).
 */
export interface DeckOrganizationActions {
  /** Creates a preset; with `fromDeckId` it copies that deck's settings and moves the deck in. */
  createPreset: (name: string, fromDeckId?: string) => string | undefined;
  updatePreset: (
    presetId: string,
    patch: { name?: string; settings?: Partial<DeckPresetSettings> },
  ) => void;
  /** Deletes a preset; its decks go back to their own settings, set to the preset's values. */
  deletePreset: (presetId: string) => void;
  /** `null` = the deck's own settings (it keeps the preset's values as its own). */
  setDeckPreset: (deckId: string, presetId: string | null) => void;
  /** Saves pooled optimizer weights on the preset and applies them to every deck in it. */
  applyPresetWeights: (presetId: string, weights: number[], reschedule: boolean) => number;
  createFolder: (name: string, deckId?: string) => string | undefined;
  renameFolder: (folderId: string, name: string) => void;
  /** Deletes a folder; its decks become unfiled (no deck, card or review is touched). */
  deleteFolder: (folderId: string) => void;
  setDeckFolder: (deckId: string, folderId: string | null) => void;
}

function fanOut(
  factory: EventFactory,
  state: CollectionState,
  preset: Pick<DeckPreset, 'settings' | 'w'>,
  deckIds: readonly string[],
  nowMs: number,
  rescheduleExisting = false,
): KnownEvent[] {
  return buildPresetParamsPayloads(state, preset, deckIds, nowMs, { rescheduleExisting }).map(
    (payload) => factory.create('DeckFSRSParamsChanged', payload, nowMs),
  );
}

/** Copies the preset's values into a leaving deck's own settings, then unlinks it. */
function leavePreset(
  factory: EventFactory,
  preset: DeckPreset,
  deckId: string,
  nowMs: number,
): KnownEvent[] {
  return [
    factory.create(
      'DeckSettingsChanged',
      { deck_id: deckId, settings: ownSettingsFromPreset(preset) },
      nowMs,
    ),
    factory.create('DeckGroupingChanged', { deck_id: deckId, preset_id: null }, nowMs),
  ];
}

export function useDeckOrganization(): DeckOrganizationActions {
  const { state, emitEvents, getEventFactory } = useApp();

  return useMemo<DeckOrganizationActions>(() => {
    const emit = (events: KnownEvent[]) => {
      if (events.length > 0) emitEvents(events);
    };
    const presetById = (id: string) => getDeckOrganization(state).presets.get(id);

    return {
      createPreset(name, fromDeckId) {
        const factory = getEventFactory();
        const nowMs = Date.now();
        const presetId = uuidv7(nowMs);
        const deck = fromDeckId === undefined ? undefined : state.decks.get(fromDeckId);
        const seed = deck ? presetSeedFromDeck(state, deck, nowMs) : undefined;
        const payload = buildDeckPresetSavedPayload({
          presetId,
          name,
          settings: seed?.settings ?? {
            new_cards_per_day: 20,
            max_reviews_per_day: 200,
            target_retention: 0.9,
          },
          ...(seed?.w ? { w: seed.w } : {}),
        });
        if (!payload) return undefined;
        const events: KnownEvent[] = [factory.create('DeckPresetSaved', payload, nowMs)];
        if (deck) {
          // The seed equals the deck's own settings and weights, so no FSRS event is needed.
          events.push(
            factory.create('DeckGroupingChanged', { deck_id: deck.id, preset_id: presetId }, nowMs),
          );
        }
        emit(events);
        return presetId;
      },

      updatePreset(presetId, patch) {
        const current = presetById(presetId);
        const payload = buildDeckPresetSavedPayload({ presetId, ...patch });
        if (!current || !payload) return;
        const factory = getEventFactory();
        const nowMs = Date.now();
        const next: DeckPreset = {
          ...current,
          settings: { ...current.settings, ...payload.settings },
        };
        emit([
          factory.create('DeckPresetSaved', payload, nowMs),
          // Also heals decks that joined on another device while the preset was being edited.
          ...fanOut(factory, state, next, listPresetDeckIds(state, presetId), nowMs),
        ]);
      },

      deletePreset(presetId) {
        const preset = presetById(presetId);
        if (!preset) return;
        const factory = getEventFactory();
        const nowMs = Date.now();
        const events: KnownEvent[] = [];
        for (const deckId of listPresetDeckIds(state, presetId)) {
          events.push(...leavePreset(factory, preset, deckId, nowMs));
        }
        events.push(factory.create('DeckPresetDeleted', { preset_id: presetId }, nowMs));
        emit(events);
      },

      setDeckPreset(deckId, presetId) {
        const factory = getEventFactory();
        const nowMs = Date.now();
        const currentPreset = getDeckPreset(state, deckId);
        if ((currentPreset?.id ?? null) === presetId) return;
        if (presetId === null) {
          if (currentPreset) emit(leavePreset(factory, currentPreset, deckId, nowMs));
          return;
        }
        const preset = presetById(presetId);
        if (!preset) return;
        emit([
          factory.create('DeckGroupingChanged', { deck_id: deckId, preset_id: presetId }, nowMs),
          ...fanOut(factory, state, preset, [deckId], nowMs),
        ]);
      },

      applyPresetWeights(presetId, weights, reschedule) {
        const preset = presetById(presetId);
        const payload = buildDeckPresetSavedPayload({ presetId, w: weights });
        if (!preset || !payload) return 0;
        const factory = getEventFactory();
        const nowMs = Date.now();
        const params = fanOut(
          factory,
          state,
          { ...preset, w: payload.w ?? weights },
          listPresetDeckIds(state, presetId),
          nowMs,
          reschedule,
        );
        emit([factory.create('DeckPresetSaved', payload, nowMs), ...params]);
        return params.length;
      },

      createFolder(name, deckId) {
        const factory = getEventFactory();
        const nowMs = Date.now();
        const folderId = uuidv7(nowMs);
        const payload = buildDeckFolderSavedPayload(folderId, name);
        if (!payload) return undefined;
        const events: KnownEvent[] = [factory.create('DeckFolderSaved', payload, nowMs)];
        if (deckId !== undefined) {
          events.push(
            factory.create('DeckGroupingChanged', { deck_id: deckId, folder_id: folderId }, nowMs),
          );
        }
        emit(events);
        return folderId;
      },

      renameFolder(folderId, name) {
        const payload = buildDeckFolderSavedPayload(folderId, name);
        if (!payload) return;
        emit([getEventFactory().create('DeckFolderSaved', payload, Date.now())]);
      },

      deleteFolder(folderId) {
        const factory = getEventFactory();
        const nowMs = Date.now();
        const events: KnownEvent[] = [];
        for (const [deckId, id] of getDeckOrganization(state).folderByDeck) {
          if (id === folderId) {
            events.push(
              factory.create('DeckGroupingChanged', { deck_id: deckId, folder_id: null }, nowMs),
            );
          }
        }
        events.push(factory.create('DeckFolderDeleted', { folder_id: folderId }, nowMs));
        emit(events);
      },

      setDeckFolder(deckId, folderId) {
        emit([
          getEventFactory().create(
            'DeckGroupingChanged',
            { deck_id: deckId, folder_id: folderId },
            Date.now(),
          ),
        ]);
      },
    };
  }, [state, emitEvents, getEventFactory]);
}
