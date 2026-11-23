import type { CollectionState } from '../events/replay.ts';
import type { DeckPresetSettings, UnknownEvent } from '../events/types.ts';
import { compareHlc } from '../hlc.ts';
import { DEFAULT_DECK_SETTINGS } from '../model/types.ts';

/**
 * Fold of the log-retained deck organization events (`DeckPresetSaved`, `DeckPresetDeleted`,
 * `DeckFolderSaved`, `DeckFolderDeleted`, `DeckGroupingChanged`) kept in `state.unknownEvents`.
 *
 * Every field is a last-writer-wins register ordered by `(hlc, event id)`, so the result depends
 * only on the set of events: any delivery order, chunking, duplication or snapshot hydration gives
 * the same answer on every device. A delete is final: a preset or folder is live once saved and
 * until any delete, and a save with a later HLC than the delete (an edit made concurrently on
 * another device) does not bring it back. Deleting writes nothing per deck: a deck that points at a
 * missing or deleted preset is on its own settings, and one that points at a missing or deleted
 * folder is unfiled, so a concurrent move to another folder or preset is never undone.
 *
 * Nothing on the study screen imports this (§8): a preset reaches the queue and FSRS only through
 * ordinary per-deck events (see `./organization.ts`).
 */

export interface DeckPreset {
  id: string;
  name: string;
  settings: DeckPresetSettings;
  /** Shared FSRS weights; absent = each deck keeps its own weights. */
  w?: number[];
}

export interface DeckFolder {
  id: string;
  name: string;
}

export interface DeckOrganization {
  /** Live presets by id. */
  presets: Map<string, DeckPreset>;
  /** Live folders by id. */
  folders: Map<string, DeckFolder>;
  /** deck id -> live preset id (decks on their own settings are absent). */
  presetByDeck: Map<string, string>;
  /** deck id -> live folder id (unfiled decks are absent). */
  folderByDeck: Map<string, string>;
}

/** Longest preset or folder name. */
export const DECK_GROUP_NAME_MAX_LENGTH = 80;

type Reg<T> = { ev: UnknownEvent; v: T } | undefined;

interface GroupRegs {
  name?: Reg<string>;
  nc?: Reg<number>;
  mr?: Reg<number>;
  tr?: Reg<number>;
  w?: Reg<number[]>;
  save?: UnknownEvent;
  del?: UnknownEvent;
}

function later(a: UnknownEvent | undefined, b: UnknownEvent): boolean {
  if (a === undefined) return true;
  const c = compareHlc(b.hlc, a.hlc);
  return c > 0 || (c === 0 && b.id > a.id);
}

function put<T>(reg: Reg<T>, ev: UnknownEvent, v: T | undefined): Reg<T> {
  return v !== undefined && later(reg?.ev, ev) ? { ev, v } : reg;
}

/** Trims and collapses whitespace; `undefined` when nothing is left. */
export function normalizeDeckGroupName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, DECK_GROUP_NAME_MAX_LENGTH).trim();
  return name.length > 0 ? name : undefined;
}

function intIn(raw: unknown, min: number, max: number): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max
    ? raw
    : undefined;
}

/** Target retention the deck options accept (0.70–0.99). */
export function validRetention(raw: unknown): number | undefined {
  return typeof raw === 'number' && raw >= 0.7 && raw <= 0.99 ? raw : undefined;
}

/** FSRS-4.5 / 5 / 6 weight vectors (17, 19 or 21 finite numbers). */
export function validWeights(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || ![17, 19, 21].includes(raw.length)) return undefined;
  return raw.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? [...(raw as number[])]
    : undefined;
}

function str(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function regsFor(map: Map<string, GroupRegs>, id: string): GroupRegs {
  let r = map.get(id);
  if (!r) {
    r = {};
    map.set(id, r);
  }
  return r;
}

function applyPresetSave(r: GroupRegs, ev: UnknownEvent, p: Record<string, unknown>): void {
  const s = (typeof p['settings'] === 'object' && p['settings'] !== null ? p['settings'] : {}) as
    Record<string, unknown> | undefined;
  const name = normalizeDeckGroupName(p['name']);
  const nc = intIn(s?.['new_cards_per_day'], 0, 9999);
  const mr = intIn(s?.['max_reviews_per_day'], 1, 99999);
  const tr = validRetention(s?.['target_retention']);
  const w = validWeights(p['w']);
  r.name = put(r.name, ev, name);
  r.nc = put(r.nc, ev, nc);
  r.mr = put(r.mr, ev, mr);
  r.tr = put(r.tr, ev, tr);
  r.w = put(r.w, ev, w);
  const touched = [name, nc, mr, tr, w].some((x) => x !== undefined);
  if (touched && later(r.save, ev)) r.save = ev;
}

function isLive(r: GroupRegs): boolean {
  return r.save !== undefined && r.del === undefined;
}

interface Folded {
  presets: Map<string, GroupRegs>;
  folders: Map<string, GroupRegs>;
  deckPreset: Map<string, Reg<string | null>>;
  deckFolder: Map<string, Reg<string | null>>;
}

function applyGrouping(f: Folded, ev: UnknownEvent, p: Record<string, unknown>): void {
  const deckId = str(p['deck_id']);
  if (deckId === undefined) return;
  for (const [key, map] of [
    ['preset_id', f.deckPreset],
    ['folder_id', f.deckFolder],
  ] as const) {
    const raw = p[key];
    const v = raw === null ? null : str(raw);
    if (v !== undefined) map.set(deckId, put(map.get(deckId), ev, v));
  }
}

function applyOrganizationEvent(f: Folded, ev: UnknownEvent): void {
  const p = ev.payload as Record<string, unknown> | null;
  if (typeof p !== 'object' || p === null || typeof ev.hlc !== 'string') return;
  switch (ev.type) {
    case 'DeckPresetSaved':
    case 'DeckPresetDeleted': {
      const id = str(p['preset_id']);
      if (id === undefined) return;
      const r = regsFor(f.presets, id);
      if (ev.type === 'DeckPresetSaved') applyPresetSave(r, ev, p);
      else if (later(r.del, ev)) r.del = ev;
      return;
    }
    case 'DeckFolderSaved':
    case 'DeckFolderDeleted': {
      const id = str(p['folder_id']);
      if (id === undefined) return;
      const r = regsFor(f.folders, id);
      if (ev.type === 'DeckFolderDeleted') {
        if (later(r.del, ev)) r.del = ev;
        return;
      }
      const name = normalizeDeckGroupName(p['name']);
      r.name = put(r.name, ev, name);
      if (name !== undefined && later(r.save, ev)) r.save = ev;
      return;
    }
    case 'DeckGroupingChanged':
      applyGrouping(f, ev, p);
  }
}

function buildOrganization(events: readonly UnknownEvent[]): DeckOrganization {
  const f: Folded = {
    presets: new Map(),
    folders: new Map(),
    deckPreset: new Map(),
    deckFolder: new Map(),
  };
  for (const ev of events) applyOrganizationEvent(f, ev);

  const out: DeckOrganization = {
    presets: new Map(),
    folders: new Map(),
    presetByDeck: new Map(),
    folderByDeck: new Map(),
  };
  for (const [id, r] of f.presets) {
    if (!isLive(r)) continue;
    const preset: DeckPreset = {
      id,
      name: r.name?.v ?? 'Untitled preset',
      settings: {
        new_cards_per_day: r.nc?.v ?? DEFAULT_DECK_SETTINGS.new_cards_per_day,
        max_reviews_per_day: r.mr?.v ?? DEFAULT_DECK_SETTINGS.max_reviews_per_day,
        target_retention: r.tr?.v ?? DEFAULT_DECK_SETTINGS.target_retention,
      },
    };
    if (r.w) preset.w = [...r.w.v];
    out.presets.set(id, preset);
  }
  for (const [id, r] of f.folders) {
    if (isLive(r)) out.folders.set(id, { id, name: r.name?.v ?? 'Untitled folder' });
  }
  for (const [deckId, reg] of f.deckPreset) {
    if (reg?.v && out.presets.has(reg.v)) out.presetByDeck.set(deckId, reg.v);
  }
  for (const [deckId, reg] of f.deckFolder) {
    if (reg?.v && out.folders.has(reg.v)) out.folderByDeck.set(deckId, reg.v);
  }
  return out;
}

const cache = new WeakMap<readonly UnknownEvent[], { length: number; org: DeckOrganization }>();

/**
 * Presets, folders and deck assignments folded from the log. Memoized per `unknownEvents` array
 * and length (the array only grows, or is replaced on hydration). Treat the result as read-only.
 */
export function getDeckOrganization(state: CollectionState): DeckOrganization {
  const events = state.unknownEvents;
  const hit = cache.get(events);
  if (hit && hit.length === events.length) return hit.org;
  const org = buildOrganization(events);
  cache.set(events, { length: events.length, org });
  return org;
}

/** The live preset a deck uses, or `undefined` when it keeps its own settings. */
export function getDeckPreset(state: CollectionState, deckId: string): DeckPreset | undefined {
  const org = getDeckOrganization(state);
  const id = org.presetByDeck.get(deckId);
  return id === undefined ? undefined : org.presets.get(id);
}

/** Ids the log ever deleted, and decks that ever had a preset or folder assignment. */
export interface DeckOrganizationHistory {
  deletedPresetIds: Set<string>;
  deletedFolderIds: Set<string>;
  /** Decks with any `DeckGroupingChanged` carrying `preset_id` (including `null`). */
  decksWithPresetHistory: Set<string>;
  /** Decks with any `DeckGroupingChanged` carrying `folder_id` (including `null`). */
  decksWithFolderHistory: Set<string>;
}

/**
 * What the user ever did with presets and folders, beyond the live fold: a deleted preset or
 * folder stays deleted (deletes are final), and a deck whose preset or folder was ever set keeps
 * the user's choice. Imports and restores use it so they never overrule the user.
 */
export function getDeckOrganizationHistory(state: CollectionState): DeckOrganizationHistory {
  const out: DeckOrganizationHistory = {
    deletedPresetIds: new Set(),
    deletedFolderIds: new Set(),
    decksWithPresetHistory: new Set(),
    decksWithFolderHistory: new Set(),
  };
  for (const ev of state.unknownEvents) {
    const p = ev.payload as Record<string, unknown> | null;
    if (typeof p !== 'object' || p === null) continue;
    if (ev.type === 'DeckPresetDeleted') {
      const id = str(p['preset_id']);
      if (id !== undefined) out.deletedPresetIds.add(id);
    } else if (ev.type === 'DeckFolderDeleted') {
      const id = str(p['folder_id']);
      if (id !== undefined) out.deletedFolderIds.add(id);
    } else if (ev.type === 'DeckGroupingChanged') {
      const deckId = str(p['deck_id']);
      if (deckId === undefined) continue;
      if (p['preset_id'] !== undefined) out.decksWithPresetHistory.add(deckId);
      if (p['folder_id'] !== undefined) out.decksWithFolderHistory.add(deckId);
    }
  }
  return out;
}
