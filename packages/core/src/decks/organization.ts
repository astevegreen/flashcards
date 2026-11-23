import {
  getActiveFsrsParamsVersion,
  resolveDeckFsrsConfig,
  type CollectionState,
} from '../events/replay.ts';
import type {
  DeckFolderSavedPayload,
  DeckFSRSParamsChangedPayload,
  DeckPresetSavedPayload,
  DeckPresetSettings,
} from '../events/types.ts';
import type { Deck, DeckSettings } from '../model/types.ts';
import {
  getDeckOrganization,
  normalizeDeckGroupName,
  validRetention,
  validWeights,
  type DeckFolder,
  type DeckPreset,
} from './fold.ts';

export * from './fold.ts';

/**
 * Shared deck option presets and one level of deck folders: payload builders, listings and the
 * FSRS fan-out. The fold itself is in `./fold.ts`.
 *
 * Presets and FSRS: a preset's target retention and weights never reach replay directly. When a
 * preset changes, or a deck joins one, the app appends one ordinary `DeckFSRSParamsChanged` per
 * member deck whose active parameters differ ({@link buildPresetParamsPayloads}). Each deck keeps
 * its own versioned parameter history, so every review still replays under the version it was
 * recorded with, and decks that never join a preset behave exactly as before.
 */

function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function byNameThenId<T extends { id: string; name: string }>(a: T, b: T): number {
  return cmpStr(a.name, b.name) || cmpStr(a.id, b.id);
}

/** Live presets sorted by name (code-unit order) then id. */
export function listDeckPresets(state: CollectionState): DeckPreset[] {
  return [...getDeckOrganization(state).presets.values()].sort(byNameThenId);
}

/** Live folders sorted by name (code-unit order) then id. */
export function listDeckFolders(state: CollectionState): DeckFolder[] {
  return [...getDeckOrganization(state).folders.values()].sort(byNameThenId);
}

/** Every deck (archived ones too) that uses the preset, sorted by id. */
export function listPresetDeckIds(state: CollectionState, presetId: string): string[] {
  const out: string[] = [];
  for (const [deckId, id] of getDeckOrganization(state).presetByDeck) {
    if (id === presetId && state.decks.has(deckId)) out.push(deckId);
  }
  return out.sort(cmpStr);
}

/** The non-archived decks in a folder, sorted by name then id. */
export function listFolderDecks(state: CollectionState, folderId: string): Deck[] {
  const out: Deck[] = [];
  for (const [deckId, id] of getDeckOrganization(state).folderByDeck) {
    const deck = state.decks.get(deckId);
    if (id === folderId && deck && !deck.archived) out.push(deck);
  }
  return out.sort(byNameThenId);
}

/** The live folder a deck is in, if any. */
export function getDeckFolder(state: CollectionState, deckId: string): DeckFolder | undefined {
  const org = getDeckOrganization(state);
  const id = org.folderByDeck.get(deckId);
  return id === undefined ? undefined : org.folders.get(id);
}

/**
 * A canonical `DeckPresetSaved` payload carrying only the valid given fields (each is its own
 * LWW register). `undefined` when nothing valid would be saved.
 */
export function buildDeckPresetSavedPayload(input: {
  presetId: string;
  name?: string;
  settings?: Partial<DeckPresetSettings>;
  w?: readonly number[];
}): DeckPresetSavedPayload | undefined {
  if (!input.presetId) return undefined;
  const out: DeckPresetSavedPayload = { preset_id: input.presetId };
  if (input.name !== undefined) {
    const name = normalizeDeckGroupName(input.name);
    if (name === undefined) return undefined;
    out.name = name;
  }
  const s = input.settings;
  if (s) {
    const settings: Partial<DeckPresetSettings> = {};
    const nc = s.new_cards_per_day;
    const mr = s.max_reviews_per_day;
    if (nc !== undefined && Number.isInteger(nc) && nc >= 0 && nc <= 9999) {
      settings.new_cards_per_day = nc;
    }
    if (mr !== undefined && Number.isInteger(mr) && mr >= 1 && mr <= 99999) {
      settings.max_reviews_per_day = mr;
    }
    const tr = validRetention(s.target_retention);
    if (tr !== undefined) settings.target_retention = tr;
    if (Object.keys(settings).length > 0) out.settings = settings;
  }
  const w = input.w === undefined ? undefined : validWeights([...input.w]);
  if (w) out.w = w;
  return Object.keys(out).length > 1 ? out : undefined;
}

/** A `DeckFolderSaved` payload, or `undefined` for an empty name. */
export function buildDeckFolderSavedPayload(
  folderId: string,
  name: string,
): DeckFolderSavedPayload | undefined {
  const clean = normalizeDeckGroupName(name);
  return folderId && clean ? { folder_id: folderId, name: clean } : undefined;
}

function sameWeights(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The per-deck `DeckFSRSParamsChanged` payloads that bring `deckIds` in line with a preset's
 * target retention and weights (a preset without weights leaves each deck's own weights alone).
 * Only decks whose active parameters differ get a payload, unless `rescheduleExisting` is set:
 * then every deck gets one that re-runs its past reviews (§4.1). Deterministic in `state`.
 */
export function buildPresetParamsPayloads(
  state: CollectionState,
  preset: Pick<DeckPreset, 'settings' | 'w'>,
  deckIds: readonly string[],
  nowMs: number,
  options: { rescheduleExisting?: boolean } = {},
): DeckFSRSParamsChangedPayload[] {
  const out: DeckFSRSParamsChangedPayload[] = [];
  for (const deckId of [...deckIds].sort(cmpStr)) {
    if (!state.decks.has(deckId)) continue;
    const current = resolveDeckFsrsConfig(state, deckId, nowMs);
    const retention = preset.settings.target_retention;
    const w = preset.w ?? current.w;
    const drifted = current.request_retention !== retention || !sameWeights(current.w, w);
    if (!drifted && !options.rescheduleExisting) continue;
    const payload: DeckFSRSParamsChangedPayload = {
      deck_id: deckId,
      params_version: getActiveFsrsParamsVersion(state, deckId) + 1,
      effective_from: nowMs,
      params: { ...current, request_retention: retention, ...(w ? { w: [...w] } : {}) },
    };
    if (options.rescheduleExisting) payload.reschedule_existing = true;
    out.push(payload);
  }
  return out;
}

/** Preset fields seeded from a deck: its limits, retention and current weights. */
export function presetSeedFromDeck(
  state: CollectionState,
  deck: Deck,
  nowMs: number,
): { settings: DeckPresetSettings; w?: number[] } {
  const w = resolveDeckFsrsConfig(state, deck.id, nowMs).w;
  return {
    settings: {
      new_cards_per_day: deck.settings.new_cards_per_day,
      max_reviews_per_day: deck.settings.max_reviews_per_day,
      target_retention: deck.settings.target_retention,
    },
    ...(w ? { w: [...w] } : {}),
  };
}

/**
 * The own-settings patch a deck gets when it leaves a preset (or the preset is deleted), so it
 * keeps studying with the same limits and retention until the user edits them.
 */
export function ownSettingsFromPreset(preset: DeckPreset): Partial<DeckSettings> {
  return { ...preset.settings };
}
