import type { KnownEvent } from '../../src/events/types.ts';
import { createEventFactory } from '../../src/events/replay.ts';
import { createHlcState } from '../../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../../src/ids.ts';
import type { ReviewRating } from '../../src/model/types.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../../src/model/presets.ts';

/** The P4 fixture: one deck of `cards` cards, each reviewed `reviewsPerCard` times a day apart. */
export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 0, 1, 10);

export function buildCollection(cards: number, reviewsPerCard: number) {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
  const deckId = 'deck-p4';
  const events: KnownEvent[] = [
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: 'P4',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: T0,
      },
      T0,
    ),
  ];
  const cardIds: string[] = [];
  for (let i = 0; i < cards; i++) {
    const noteId = deriveNoteId(deckId, `n${i}`);
    cardIds.push(deriveCardId(noteId, 'layout:vocab-ko:recognition', 0));
    events.push(
      factory.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: deckId,
          source_key: `n${i}`,
          fields: { word: `w${i}`, meaning: `m${i}` },
          tags: [],
        },
        T0,
      ),
    );
  }
  for (let r = 0; r < reviewsPerCard; r++) {
    const at = T0 + (r + 1) * DAY;
    cardIds.forEach((cardId, i) => {
      events.push(
        factory.create(
          'ReviewRecorded',
          {
            review_id: `rev-${i}-${r}`,
            card_id: cardId,
            rating: (((i + r) % 4) + 1) as ReviewRating,
            reviewed_at: at,
            tz_offset: 0,
            duration_ms: 1000,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: at,
          },
          at,
        ),
      );
    });
  }
  return { events, cardIds, deckId, factory };
}
