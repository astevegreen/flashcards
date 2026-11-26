import type { CollectionState } from '../../src/events/replay.ts';
import { getStudyDayIndex } from '../../src/fsrs/scheduler.ts';
import { isRaiseOnDay, listNewCardRaises } from '../../src/study/new-card-raises.ts';

/**
 * Extra new cards custom study granted today by raises whose deck scope includes `deckId`
 * (`NewCardLimitRaised`, kept verbatim in `unknownEvents`), whatever their category scope. A raise
 * counts on the study day containing its `raised_at` (in the raising device's offset, with the
 * deck's rollover hour). Raises add up; a repeated `raise_id` counts once (its largest value), so
 * the result is independent of delivery order and duplicates.
 *
 * This is the gross grant: a raise shared by several decks is counted in full for each of them.
 * `buildStudyQueue` spends each raise once, as one pool for its whole scope.
 */
export function getExtraNewCardsToday(
  state: CollectionState,
  deckId: string,
  nowMs: number,
  tzOffsetMinutes: number,
  dayStartHour: number,
): number {
  const today = getStudyDayIndex(nowMs, tzOffsetMinutes, dayStartHour);
  let extra = 0;
  for (const r of listNewCardRaises(state)) {
    if (r.deckIds !== null && !r.deckIds.has(deckId)) continue;
    if (!isRaiseOnDay(r, today, tzOffsetMinutes, dayStartHour)) continue;
    extra += r.extra;
  }
  return extra;
}
