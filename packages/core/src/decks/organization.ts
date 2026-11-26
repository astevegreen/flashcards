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
  DeckSettingsChangedPayload,
} from '../events/types.ts';
import type { Deck } from '../model/types.ts';
import {
  getDeckOrganization,
  normalizeDeckGroupName,
  validRetention,
  validWeights,
  type DeckFolder,
  type DeckPreset,
} from './fold.ts';
import { compareCodeUnits } from '../compare.ts';

export * from './fold.ts';

/**
 * Shared deck option presets and one level of deck folders: payload builders, listings and the
 * FSRS fan-out. The fold itself is in `./fold.ts`.
 *
 * A preset never reaches the study queue or replay directly. When a preset changes, or a deck
 * joins one, the app appends ordinary per-deck events for the member decks that differ: a
 * `DeckSettingsChanged` with the changed limits and retention
 * ({@link buildPresetSettingsPayloads}) and a `DeckFSRSParamsChanged` with the changed retention
 * or weights ({@link buildPresetParamsPayloads}). Each deck keeps its own versioned parameter
 * history, so every review still replays under the version it was recorded with, and decks that
 * never join a preset behave exactly as before. Concurrent edits can still leave a member deck
 * behind its preset; {@link buildPresetCatchUp} finds and fixes those after a sync and when the
 * Library opens.
 */

function byNameThenId<T extends { id: string; name: string }>(a: T, b: T): number {
  return compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id);
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
  return out.sort(compareCodeUnits);
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

/** A preset value that reaches its decks: the three deck settings, and the FSRS weights. */
export type PresetField = keyof DeckPresetSettings | 'w';

/** Every preset field: used when a deck joins a preset, and by the catch-up step. */
export const ALL_PRESET_FIELDS: readonly PresetField[] = [
  'new_cards_per_day',
  'max_reviews_per_day',
  'target_retention',
  'w',
];

const SETTINGS_FIELDS = ['new_cards_per_day', 'max_reviews_per_day', 'target_retention'] as const;

/**
 * Preset copies write FSRS parameter versions `stamp * 1000 + salt`, where `salt` comes from the
 * device id and `stamp` is past the active version and at least the current time in ms. Replay
 * keeps one entry per version, so two devices that copy a preset at the same moment must not write
 * the same version: with distinct versions both entries survive and every review keeps replaying
 * under the parameters it was recorded with. Versions stay ordered by time.
 */
const VERSION_SALT_RANGE = 1000;

function deviceSalt(deviceId: string): number {
  let h = 0x811c9dc5;
  for (const ch of deviceId) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % VERSION_SALT_RANGE;
}

/** The FSRS parameters version a preset copy on `deviceId` writes for a deck (see above). */
export function nextPresetParamsVersion(
  state: CollectionState,
  deckId: string,
  nowMs: number,
  deviceId: string,
): number {
  const active = getActiveFsrsParamsVersion(state, deckId);
  const stamp = Math.max(Math.floor(active / VERSION_SALT_RANGE) + 1, Math.floor(nowMs));
  return stamp * VERSION_SALT_RANGE + deviceSalt(deviceId);
}

/**
 * The per-deck `DeckSettingsChanged` payloads that copy a preset's daily limits and target
 * retention into the own settings of `deckIds`. Each payload carries only the `fields` given:
 * deck settings merge per field, so copying a field the user did not change could overwrite a
 * newer value another device wrote. With no `fields` (catch-up, joining a preset) only fields that
 * differ on a deck are copied. An edit names its `fields`, and those are copied even where the deck
 * already holds the value: the copy is this device's vote in the per-field merge, so skipping it
 * would let a concurrent edit from another device win on the deck while this edit wins on the
 * preset. The study queue only reads `deck.settings`, so this is how a preset's limits take
 * effect, and a deck that leaves the preset simply keeps them.
 */
export function buildPresetSettingsPayloads(
  state: CollectionState,
  preset: Pick<DeckPreset, 'settings'>,
  deckIds: readonly string[],
  fields?: readonly PresetField[],
): DeckSettingsChangedPayload[] {
  const out: DeckSettingsChangedPayload[] = [];
  for (const deckId of [...deckIds].sort(compareCodeUnits)) {
    const own = state.decks.get(deckId)?.settings;
    if (!own) continue;
    const settings: Partial<DeckPresetSettings> = {};
    for (const key of SETTINGS_FIELDS) {
      const copy = fields === undefined ? own[key] !== preset.settings[key] : fields.includes(key);
      if (copy) {
        settings[key] = preset.settings[key];
      }
    }
    if (Object.keys(settings).length > 0) out.push({ deck_id: deckId, settings });
  }
  return out;
}

/**
 * The per-deck `DeckFSRSParamsChanged` payloads that bring `deckIds` in line with a preset. Only
 * the `fields` given are taken from the preset (`target_retention`, `w`); everything else stays at
 * the deck's active parameters, and a preset without weights leaves each deck its own. Only decks
 * whose active parameters differ get a payload, unless `rescheduleExisting` is set: then every
 * deck gets one that re-runs its past reviews (§4.1). Versions come from
 * {@link nextPresetParamsVersion}. Deterministic in `state`, `nowMs` and `deviceId`.
 */
export function buildPresetParamsPayloads(
  state: CollectionState,
  preset: Pick<DeckPreset, 'settings' | 'w'>,
  deckIds: readonly string[],
  nowMs: number,
  options: {
    deviceId: string;
    fields?: readonly PresetField[];
    rescheduleExisting?: boolean;
  },
): DeckFSRSParamsChangedPayload[] {
  const fields = options.fields ?? ALL_PRESET_FIELDS;
  const out: DeckFSRSParamsChangedPayload[] = [];
  for (const deckId of [...deckIds].sort(compareCodeUnits)) {
    if (!state.decks.has(deckId)) continue;
    const current = resolveDeckFsrsConfig(state, deckId, nowMs);
    const retention = fields.includes('target_retention')
      ? preset.settings.target_retention
      : current.request_retention;
    const w = fields.includes('w') && preset.w ? preset.w : current.w;
    const drifted = current.request_retention !== retention || !sameWeights(current.w, w);
    if (!drifted && !options.rescheduleExisting) continue;
    const payload: DeckFSRSParamsChangedPayload = {
      deck_id: deckId,
      params_version: nextPresetParamsVersion(state, deckId, nowMs, options.deviceId),
      effective_from: nowMs,
      params: { ...current, request_retention: retention, ...(w ? { w: [...w] } : {}) },
    };
    if (options.rescheduleExisting) payload.reschedule_existing = true;
    out.push(payload);
  }
  return out;
}

/**
 * Catch-up: for every live preset, the copies that bring each member deck back in line with it.
 * Decks drift when a deck joins a preset on one device while another device edits that preset,
 * when two devices copy different fields at once, or when an older build edits a member deck's own
 * settings. Empty when every member already matches, so running it again, or on several devices at
 * once, writes nothing more (devices that agree on the preset write the same values).
 */
export function buildPresetCatchUp(
  state: CollectionState,
  nowMs: number,
  deviceId: string,
): { settings: DeckSettingsChangedPayload[]; params: DeckFSRSParamsChangedPayload[] } {
  const settings: DeckSettingsChangedPayload[] = [];
  const params: DeckFSRSParamsChangedPayload[] = [];
  for (const preset of listDeckPresets(state)) {
    const deckIds = listPresetDeckIds(state, preset.id);
    if (deckIds.length === 0) continue;
    settings.push(...buildPresetSettingsPayloads(state, preset, deckIds));
    params.push(...buildPresetParamsPayloads(state, preset, deckIds, nowMs, { deviceId }));
  }
  return { settings, params };
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
