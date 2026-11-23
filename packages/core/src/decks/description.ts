import type { CollectionState } from '../events/replay.ts';
import type { UnknownEvent } from '../events/types.ts';
import { compareHlc } from '../hlc.ts';

/**
 * Deck descriptions: plain text shown on the deck overview before study. Never HTML; screens
 * render it as a text node.
 *
 * `DeckDescriptionChanged` is log-retained (see its payload docs). Per deck, any event the user
 * wrote beats any event a package or the starter catalog wrote (`from_package`); within each kind
 * the newest by `(hlc, event id)` wins. So a package never brings back a description the user
 * cleared or replaces one they wrote, even from a device that has not synced their text yet, and
 * the result is the same under any delivery order, duplication or snapshot hydration. Nothing on
 * the study screen imports this module (§8).
 */

/** Longest deck description, in UTF-16 code units. */
export const DECK_DESCRIPTION_MAX_LENGTH = 2000;

/** Drops control characters other than tab and line feed. */
function dropControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 9 || c === 10 || (c >= 32 && c !== 127)) out += ch;
  }
  return out;
}

/** Removes trailing spaces and tabs. */
function trimEndSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end -= 1;
  return text.slice(0, end);
}

/**
 * Canonical description: CRLF and CR -> LF, other control characters dropped, trailing spaces before a
 * line break removed, at most one blank line in a row, trimmed and capped at
 * {@link DECK_DESCRIPTION_MAX_LENGTH}. `''` means no description.
 */
export function normalizeDeckDescription(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // A line-by-line scan, not regexes: descriptions come from users and packages, so the work
  // stays linear in the input length.
  const lines: string[] = [];
  for (const line of raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    const text = trimEndSpaces(dropControlChars(line));
    if (text === '' && lines.at(-1) === '') continue;
    lines.push(text);
  }
  return lines.join('\n').trim().slice(0, DECK_DESCRIPTION_MAX_LENGTH).trim();
}

type DescriptionPayload = { deck_id?: unknown; description?: unknown; from_package?: unknown };

function fromUser(ev: UnknownEvent): boolean {
  return (ev.payload as DescriptionPayload).from_package !== true;
}

function wins(a: UnknownEvent | undefined, b: UnknownEvent): boolean {
  if (a === undefined) return true;
  if (fromUser(a) !== fromUser(b)) return fromUser(b);
  const c = compareHlc(b.hlc, a.hlc);
  return c > 0 || (c === 0 && b.id > a.id);
}

interface Folded {
  length: number;
  /** deck id -> description, for decks that have one. */
  map: Map<string, string>;
  /** Decks with any `DeckDescriptionChanged`, including cleared ones. */
  touched: Set<string>;
}

function fold(events: readonly UnknownEvent[]): Folded {
  const newest = new Map<string, UnknownEvent>();
  for (const ev of events) {
    if (ev.type !== 'DeckDescriptionChanged' || typeof ev.hlc !== 'string') continue;
    const p = ev.payload as DescriptionPayload | null;
    if (typeof p?.deck_id !== 'string' || p.deck_id === '') continue;
    if (typeof p.description !== 'string') continue;
    if (wins(newest.get(p.deck_id), ev)) newest.set(p.deck_id, ev);
  }
  const map = new Map<string, string>();
  for (const [deckId, ev] of newest) {
    const text = normalizeDeckDescription((ev.payload as { description: string }).description);
    if (text) map.set(deckId, text);
  }
  return { length: events.length, map, touched: new Set(newest.keys()) };
}

const cache = new WeakMap<readonly UnknownEvent[], Folded>();

function folded(state: CollectionState): Folded {
  const events = state.unknownEvents;
  const hit = cache.get(events);
  if (hit?.length === events.length) return hit;
  const next = fold(events);
  cache.set(events, next);
  return next;
}

/** Every deck's description (decks without one are absent). Memoized; treat as read-only. */
export function getDeckDescriptions(state: CollectionState): ReadonlyMap<string, string> {
  return folded(state).map;
}

/**
 * Whether the deck has ever had a description event, even one that cleared it. Imports use it to
 * fill in a description only for a deck that never had one.
 */
export function hasDeckDescriptionHistory(state: CollectionState, deckId: string): boolean {
  return folded(state).touched.has(deckId);
}

/** The deck's description, or `''` when it has none. */
export function getDeckDescription(state: CollectionState, deckId: string): string {
  return getDeckDescriptions(state).get(deckId) ?? '';
}
