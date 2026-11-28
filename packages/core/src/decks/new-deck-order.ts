import type { KnownEvent } from '../events/types.ts';
import type { CollectionState } from '../events/replay.ts';
import type { NewCardOrder } from '../model/types.ts';
import { studyOrderToNewCardOrder } from '../study/card-order.ts';

/**
 * The new-card order a deck created now starts with: the Settings "Card order (all decks)"
 * (`preferences.study_order`), or `undefined` while the user never chose one (the deck default
 * `source` then applies, and creation events stay as they were).
 */
export function newDeckCardOrder(state: CollectionState): NewCardOrder | undefined {
  const order = state.preferences.study_order;
  return order === undefined ? undefined : studyOrderToNewCardOrder(order);
}

/**
 * Writes the Settings card order into the `DeckCreated` events of decks that do not exist yet in
 * `state`, before the events are applied and saved, so the order lives in the creation event and
 * replay stays deterministic. A `DeckCreated` that already carries `settings.new_card_order` (an
 * explicit order from its package or source) keeps it, and a create for a deck that already exists
 * (a re-import, a second device adding the same starter) is left alone so it never resets an order
 * the user changed. Returns `events` itself when nothing changes; never mutates an event.
 */
export function withNewDeckCardOrder(
  state: CollectionState,
  events: readonly KnownEvent[],
): readonly KnownEvent[] {
  const order = newDeckCardOrder(state);
  if (order === undefined) return events;
  let out: KnownEvent[] | undefined;
  events.forEach((ev, i) => {
    if (ev.type !== 'DeckCreated') return;
    const p = ev.payload;
    if (p.settings?.new_card_order !== undefined || state.decks.has(p.deck_id)) return;
    out ??= events.slice();
    out[i] = { ...ev, payload: { ...p, settings: { ...p.settings, new_card_order: order } } };
  });
  return out ?? events;
}
