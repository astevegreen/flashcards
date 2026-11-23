import type { CollectionState } from '../events/replay.ts';
import type { UnknownEvent } from '../events/types.ts';
import { compareHlc } from '../hlc.ts';

/**
 * Deck descriptions: plain text shown on the deck overview before study. Never HTML; screens
 * render it as a text node.
 *
 * `DeckDescriptionChanged` is log-retained (see its payload docs). The newest event per deck by
 * `(hlc, event id)` wins, so the result is the same under any delivery order, duplication or
 * snapshot hydration. Nothing on the study screen imports this module (§8).
 */

/** Longest deck description, in UTF-16 code units. */
export const DECK_DESCRIPTION_MAX_LENGTH = 2000;

/** Drops control characters other than tab and line feed. */
function dropControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 9 || c === 10 || (c >= 32 && c !== 127)) out += ch;
  }
  return out;
}

/**
 * Canonical description: CRLF -> LF, other control characters dropped, trailing spaces before a
 * line break removed, at most one blank line in a row, trimmed and capped at
 * {@link DECK_DESCRIPTION_MAX_LENGTH}. `''` means no description.
 */
export function normalizeDeckDescription(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return dropControlChars(raw.replace(/\r\n?/g, '\n'))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, DECK_DESCRIPTION_MAX_LENGTH)
    .trim();
}

function later(a: UnknownEvent | undefined, b: UnknownEvent): boolean {
  if (a === undefined) return true;
  const c = compareHlc(b.hlc, a.hlc);
  return c > 0 || (c === 0 && b.id > a.id);
}

function buildDescriptions(events: readonly UnknownEvent[]): Map<string, string> {
  const newest = new Map<string, UnknownEvent>();
  for (const ev of events) {
    if (ev.type !== 'DeckDescriptionChanged' || typeof ev.hlc !== 'string') continue;
    const p = ev.payload as { deck_id?: unknown; description?: unknown } | null;
    if (typeof p?.deck_id !== 'string' || p.deck_id === '') continue;
    if (typeof p.description !== 'string') continue;
    if (later(newest.get(p.deck_id), ev)) newest.set(p.deck_id, ev);
  }
  const out = new Map<string, string>();
  for (const [deckId, ev] of newest) {
    const text = normalizeDeckDescription((ev.payload as { description: string }).description);
    if (text) out.set(deckId, text);
  }
  return out;
}

const cache = new WeakMap<readonly UnknownEvent[], { length: number; map: Map<string, string> }>();

/** Every deck's description (decks without one are absent). Memoized; treat as read-only. */
export function getDeckDescriptions(state: CollectionState): ReadonlyMap<string, string> {
  const events = state.unknownEvents;
  const hit = cache.get(events);
  if (hit && hit.length === events.length) return hit.map;
  const map = buildDescriptions(events);
  cache.set(events, { length: events.length, map });
  return map;
}

/** The deck's description, or `''` when it has none. */
export function getDeckDescription(state: CollectionState, deckId: string): string {
  return getDeckDescriptions(state).get(deckId) ?? '';
}
