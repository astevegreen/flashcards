import type { Card } from '@flash/core';
import type { MaterializedCardRow } from '@flash/platform';

/** The `Storage` row a replayed card is cached as. */
export function cardToRow(card: Card): MaterializedCardRow {
  return {
    id: card.id,
    deck_id: card.deck_id,
    note_id: card.note_id,
    layout_id: card.layout_id,
    due: card.schedule.due,
    schedule: card.schedule,
  };
}
