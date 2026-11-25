import type { CollectionState, KnownEvent } from '@flash/core';
import { canCreateOrImportDeck, type EntitlementState } from '@flash/core/license';

/** The decks `events` would create that `state` (and `pending`) don't already have. */
export function newDeckIds(
  state: CollectionState,
  events: readonly KnownEvent[],
  pending?: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'DeckCreated') continue;
    const id = ev.payload.deck_id;
    if (!state.decks.has(id) && !pending?.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Free tier: why `newDecks` may not be added, or `undefined` when they may (C14). Linking a source
 * is gated in the UI, but a folder scan, an Inbox package or a package refresh adds decks later.
 * `pending` holds decks this run already added that `state` may not show yet.
 */
export function deckLimitReason(
  entitlement: EntitlementState | undefined,
  state: CollectionState,
  newDecks: readonly string[],
  pending?: ReadonlySet<string>,
): string | undefined {
  if (!entitlement || newDecks.length === 0) return undefined;
  let active = 0;
  for (const deck of state.decks.values()) if (!deck.archived) active += 1;
  for (const id of pending ?? []) if (!state.decks.has(id)) active += 1;
  const gate = canCreateOrImportDeck(active + newDecks.length - 1, entitlement);
  return gate.allowed ? undefined : (gate.reason ?? 'Free tier deck limit reached.');
}
