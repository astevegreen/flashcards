import type { CollectionState } from '../events/replay.ts';
import type { NewCardLimitRaisedPayload } from '../events/types.ts';
import { getStudyDayIndex } from '../fsrs/scheduler.ts';
import type { Card } from '../model/types.ts';
import {
  isLeechCard,
  LEECH_CATEGORY,
  matchesCategoryCriterion,
  normalizeCardFilter,
  type CategoryCriterion,
} from './filter.ts';

/** Largest single "extra new cards today" raise. */
export const MAX_EXTRA_NEW_CARDS = 9999;

/**
 * One custom study "extra new cards today" grant (`NewCardLimitRaised`), sanitized.
 *
 * A raise is one **shared** pool of `extra` new cards for its whole scope, never a per-deck bonus:
 * `deckIds` (`null` = every deck) and optional `categories` (note tags, as in the panel filter)
 * decide which new cards may use it. It counts on the study day containing `raisedAt` (in the
 * raising device's offset `tz`, with the card's deck rollover hour).
 */
export interface NewCardRaise {
  id: string;
  extra: number;
  raisedAt: number;
  tz: number | undefined;
  deckIds: ReadonlySet<string> | null;
  categories?: CategoryCriterion;
}

/** Code-unit order (not localeCompare): identical on every device. */
function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function canonicalKey(r: NewCardRaise): string {
  return JSON.stringify([
    r.extra,
    r.raisedAt,
    r.tz ?? null,
    r.deckIds ? [...r.deckIds].sort(cmpStr) : null,
    r.categories ?? null,
  ]);
}

function parseRaise(payload: unknown): NewCardRaise | undefined {
  const p = (payload ?? {}) as Partial<NewCardLimitRaisedPayload>;
  const n = p.extra;
  if (typeof p.raise_id !== 'string' || typeof n !== 'number' || !(n >= 1)) return undefined;
  if (typeof p.raised_at !== 'number' || !Number.isFinite(p.raised_at)) return undefined;
  const deckIds = Array.isArray(p.deck_ids)
    ? p.deck_ids.filter((d): d is string => typeof d === 'string' && d.length > 0)
    : [];
  const categories = normalizeCardFilter({ categories: p.categories }).categories;
  return {
    id: p.raise_id,
    extra: Math.min(MAX_EXTRA_NEW_CARDS, Math.floor(n)),
    raisedAt: p.raised_at,
    tz: typeof p.tz_offset === 'number' ? p.tz_offset : undefined,
    deckIds: deckIds.length > 0 ? new Set(deckIds) : null,
    ...(categories ? { categories } : {}),
  };
}

/**
 * Every valid raise in the log, one per `raise_id` (a repeated id keeps its largest grant, ties
 * broken canonically), sorted by `(raisedAt, id)`. Depends only on the set of events, so it is the
 * same under any delivery order or duplication.
 */
export function listNewCardRaises(state: CollectionState): NewCardRaise[] {
  const byId = new Map<string, NewCardRaise>();
  for (const ev of state.unknownEvents) {
    if (ev.type !== 'NewCardLimitRaised') continue;
    const r = parseRaise(ev.payload);
    if (!r) continue;
    const prev = byId.get(r.id);
    if (
      prev === undefined ||
      r.extra > prev.extra ||
      (r.extra === prev.extra && canonicalKey(r) < canonicalKey(prev))
    ) {
      byId.set(r.id, r);
    }
  }
  return [...byId.values()].sort((a, b) => a.raisedAt - b.raisedAt || cmpStr(a.id, b.id));
}

/** True when `raise` counts on the study day `todayIndex` for a deck with rollover `dayStart`. */
export function isRaiseOnDay(
  raise: NewCardRaise,
  todayIndex: number,
  fallbackTz: number,
  dayStart: number,
): boolean {
  return getStudyDayIndex(raise.raisedAt, raise.tz ?? fallbackTz, dayStart) === todayIndex;
}

/** True when `card` is inside the raise's deck / category scope (the day is checked separately). */
export function isCardInRaiseScope(
  state: CollectionState,
  raise: NewCardRaise,
  card: Card,
): boolean {
  if (raise.deckIds !== null && !raise.deckIds.has(card.deck_id)) return false;
  if (!raise.categories) return true;
  const note = state.notes.get(card.note_id);
  const tags = (note?.tags ?? []).map((t) => t.normalize('NFC').trim().toLowerCase());
  if (isLeechCard(card)) tags.push(LEECH_CATEGORY);
  return matchesCategoryCriterion(tags, raise.categories);
}
