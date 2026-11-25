import {
  createEventFactory,
  replayAllEvents,
  type CollectionState,
  type EventFactory,
} from '../../src/events/replay.ts';
import type { KnownEvent } from '../../src/events/types.ts';
import { createHlcState } from '../../src/hlc.ts';
import { FLASH_NAMESPACE_UUID, uuidv5 } from '../../src/ids.ts';
import type { ReviewRating } from '../../src/model/types.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../../src/samples/decks.ts';

/** Korea Standard Time, the offset every fixture review is recorded in. */
const KST = 540;

/** The sample collection plus helpers that append reviews and practice in time order. */
export interface ReviewFixture {
  factory: EventFactory;
  events: KnownEvent[];
  review: (cardId: string, rating: ReviewRating, at: number) => void;
  practice: (cardId: string, rating: ReviewRating, at: number, sessionId?: string) => string;
  state: () => CollectionState;
}

/**
 * The sample decks on a fresh device. With `withProduction`, the Korean deck also enables its
 * Production layout, so every Korean note has two sibling cards.
 */
export function makeReviewFixture(
  options: { deviceId?: string; withProduction?: boolean } = {},
): ReviewFixture {
  const deviceId = options.deviceId ?? 'dev-a';
  const factory = createEventFactory(deviceId, 0, createHlcState(deviceId, SAMPLE_SEED_EPOCH_MS));
  const events: KnownEvent[] = buildSampleDeckEvents(factory);
  if (options.withProduction) {
    const koDeck = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
    const layouts = ['layout:vocab-ko:production', 'layout:vocab-ko:recognition'];
    events.push(
      factory.create(
        'DeckSettingsChanged',
        { deck_id: koDeck, settings: { enabled_layout_ids: layouts } },
        SAMPLE_SEED_EPOCH_MS + 1000,
      ),
    );
  }
  let n = 0;
  const nextId = (prefix: string) => {
    n += 1;
    return `${prefix}-${String(n).padStart(4, '0')}`;
  };
  return {
    factory,
    events,
    review(cardId, rating, at) {
      events.push(
        factory.create(
          'ReviewRecorded',
          {
            review_id: nextId('rev'),
            card_id: cardId,
            rating,
            reviewed_at: at,
            tz_offset: KST,
            duration_ms: 2000,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: at,
          },
          at,
        ),
      );
    },
    practice(cardId, rating, at, sessionId = 'session-1') {
      const practiceId = nextId('prac');
      events.push(
        factory.create(
          'PracticeRecorded',
          {
            practice_id: practiceId,
            session_id: sessionId,
            card_id: cardId,
            rating,
            practiced_at: at,
            tz_offset: KST,
            duration_ms: 1500,
            answer_mode: 'flip',
          },
          at,
        ),
      );
      return practiceId;
    },
    state: () => replayAllEvents(events),
  };
}
