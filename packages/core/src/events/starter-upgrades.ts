import { compareHlc } from '../hlc.ts';
import type { Note } from '../model/types.ts';
import type { CollectionState } from './replay.ts';
import type { UnknownEvent } from './types.ts';

/**
 * `StarterNoteUpgraded`: the starter-deck upgrade's field writes (`starters/upgrade.ts`), ordered
 * so that a user's edit of a field always wins over the upgrade of that field.
 *
 * The upgrade replaces text an older starter release generated. It writes, per field, the new
 * value and `base_hlc`: the HLC of the field register (`note:<id>:field:<name>`) it saw holding
 * the old text. It never writes that register. The field shows the upgrade's value while the
 * register is no newer than `base_hlc`, that is while no `NoteUpserted` the upgrading device had
 * not seen has written the field. So:
 *
 * - an edit the upgrading device had not seen (made offline on another device, with any HLC)
 *   is newer than `base_hlc` (HLCs grow along causality), and wins in every delivery order;
 * - an edit made after the upgrade synced is newer too, and wins;
 * - the seed's own write, even when it arrives after the upgrade, is not, so the upgrade shows.
 *
 * Known gap: the register must be the one the upgrading device saw. If two devices seeded the same
 * starter deck (on an older release) before syncing, and one upgraded before it saw the other's
 * seed, the newer seed may hold the register: it reads as an unseen edit, and that field keeps the
 * old text (`StarterDeckUpgraded` stops a re-run). That costs one stale credit or gloss, never a
 * user's text.
 *
 * When several upgrades apply to a field, the one with the greatest `(hlc, id)` shows. Every
 * input is an event in the log and the register is LWW, so any delivery order, duplicate or
 * chunking gives the same fields.
 *
 * Log-retained like `StarterDeckUpgraded`: the events stay in `unknownEvents` (absent from
 * `isKnownEventType`), so the snapshot and sync formats are unchanged, and an older build keeps
 * them verbatim (it shows the old text until it updates; hydration then re-applies them).
 */
export const STARTER_NOTE_UPGRADED = 'StarterNoteUpgraded';

/** The register a `NoteUpserted` writes for one note field (see `applyNoteUpserted`). */
export function noteFieldRegisterKey(noteId: string, field: string): string {
  return `note:${noteId}:field:${field}`;
}

interface FieldUpgrade {
  id: string;
  hlc: string;
  value: string;
  base: string;
}

interface UpgradeIndex {
  /** The `unknownEvents` array indexed so far (hydration replaces it). */
  events: readonly UnknownEvent[];
  scanned: number;
  /** noteId -> field -> upgrades. */
  byNote: Map<string, Map<string, FieldUpgrade[]>>;
}

const indexes = new WeakMap<CollectionState, UpgradeIndex>();

/** Reads one event's field upgrades defensively (any build, or a hand-edited log, wrote it). */
function readUpgrade(ev: UnknownEvent): { noteId: string; fields: [string, FieldUpgrade][] } {
  const p = ev.payload as { note_id?: unknown; fields?: unknown } | null;
  const fields: [string, FieldUpgrade][] = [];
  if (typeof p !== 'object' || p === null || typeof p.note_id !== 'string') {
    return { noteId: '', fields };
  }
  if (typeof p.fields !== 'object' || p.fields === null || typeof ev.hlc !== 'string') {
    return { noteId: p.note_id, fields };
  }
  for (const [field, raw] of Object.entries(p.fields as Record<string, unknown>)) {
    const f = raw as { value?: unknown; base_hlc?: unknown } | null;
    if (typeof f !== 'object' || f === null) continue;
    if (typeof f.value !== 'string' || typeof f.base_hlc !== 'string') continue;
    fields.push([field, { id: ev.id, hlc: ev.hlc, value: f.value, base: f.base_hlc }]);
  }
  return { noteId: p.note_id, fields };
}

/** The upgrade index of `state`, brought up to date with `state.unknownEvents`. */
function upgradeIndex(state: CollectionState): UpgradeIndex {
  let index = indexes.get(state);
  const events = state.unknownEvents;
  if (index?.events !== events || index.scanned > events.length) {
    index = { events, scanned: 0, byNote: new Map() };
    indexes.set(state, index);
  }
  for (; index.scanned < events.length; index.scanned += 1) {
    const ev = events[index.scanned];
    if (ev?.type !== STARTER_NOTE_UPGRADED) continue;
    const { noteId, fields } = readUpgrade(ev);
    if (fields.length === 0) continue;
    let byField = index.byNote.get(noteId);
    if (!byField) index.byNote.set(noteId, (byField = new Map()));
    for (const [field, upgrade] of fields) {
      const list = byField.get(field);
      if (list) list.push(upgrade);
      else byField.set(field, [upgrade]);
    }
  }
  return index;
}

/** `a` is ordered after `b` by `(hlc, id)`. */
function isLater(a: FieldUpgrade, b: FieldUpgrade): boolean {
  const cmp = compareHlc(a.hlc, b.hlc);
  return cmp > 0 || (cmp === 0 && a.id > b.id);
}

/**
 * Sets every upgraded field of `note` to the upgrade value that currently wins (see the module
 * doc); fields with no applicable upgrade keep the register's value. Returns true when a field
 * changed. Safe after any event: it depends only on the registers and the retained events.
 */
export function applyStarterNoteUpgrades(state: CollectionState, note: Note): boolean {
  const byField = upgradeIndex(state).byNote.get(note.id);
  if (!byField) return false;
  let changed = false;
  for (const [field, upgrades] of byField) {
    const register = state.fieldHlcs.get(noteFieldRegisterKey(note.id, field));
    let winner: FieldUpgrade | undefined;
    for (const upgrade of upgrades) {
      if (register !== undefined && compareHlc(register, upgrade.base) > 0) continue;
      if (winner === undefined || isLater(upgrade, winner)) winner = upgrade;
    }
    if (winner !== undefined && note.fields[field] !== winner.value) {
      note.fields[field] = winner.value;
      changed = true;
    }
  }
  return changed;
}

/** The note a retained `StarterNoteUpgraded` names, or undefined for any other event. */
export function starterUpgradeNoteId(ev: UnknownEvent): string | undefined {
  if (ev.type !== STARTER_NOTE_UPGRADED) return undefined;
  const noteId = (ev.payload as { note_id?: unknown } | null)?.note_id;
  return typeof noteId === 'string' ? noteId : undefined;
}

/** Note ids with at least one retained upgrade (snapshot hydration re-applies them). */
export function starterUpgradedNoteIds(state: CollectionState): Iterable<string> {
  return upgradeIndex(state).byNote.keys();
}
