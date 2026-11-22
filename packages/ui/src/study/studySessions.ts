import {
  buildPracticeQueue,
  buildReviewAheadQueue,
  isCardFilterEmpty,
  uuidv7,
  type CardFilter,
  type CollectionState,
  type EventFactory,
  type KnownEvent,
} from '@flash/core';
import type { StudySession } from './filterStore.ts';

/** What a custom study session needs from `useApp()` to append its own events. */
export interface SessionDeps {
  state: CollectionState;
  getEventFactory: () => EventFactory;
  emitEvents: (events: readonly KnownEvent[]) => void;
}

/**
 * Cram / practice session (Phase 9): every card matching `filter`, answers recorded as
 * `PracticeRecorded` (never FSRS). The queue is derived from this session's events, so it
 * survives re-renders and converges with what other devices see; Undo appends `PracticeUndone`.
 */
export function createPracticeSession(deps: SessionDeps, filter: CardFilter): StudySession {
  const sessionId = uuidv7();
  const answered: string[] = [];
  return {
    kind: 'practice',
    buildQueue: (state, scope) =>
      buildPracticeQueue(state, {
        filter,
        sessionId,
        nowMs: scope.nowMs,
        tzOffsetMinutes: scope.tzOffsetMinutes,
        ...(scope.deckId !== undefined ? { deckId: scope.deckId } : {}),
      }),
    rate: (card, rating, durationMs) => {
      const nowMs = Date.now();
      const practiceId = uuidv7(nowMs);
      answered.push(practiceId);
      deps.emitEvents([
        deps.getEventFactory().create(
          'PracticeRecorded',
          {
            practice_id: practiceId,
            session_id: sessionId,
            card_id: card.id,
            rating,
            practiced_at: nowMs,
            tz_offset: -new Date(nowMs).getTimezoneOffset(),
            duration_ms: Math.max(0, Math.round(durationMs)),
            answer_mode: deps.state.layouts.get(card.layout_id)?.answer_mode ?? 'flip',
          },
          nowMs,
        ),
      ]);
    },
    undo: () => {
      const practiceId = answered.pop();
      if (practiceId === undefined) return false;
      deps.emitEvents([
        deps.getEventFactory().create('PracticeUndone', { practice_id: practiceId }, Date.now()),
      ]);
      return true;
    },
  };
}

/**
 * Review-ahead session: review cards due within `days` study days, answered as normal FSRS
 * reviews (`rateCard` / Undo stay the default handlers).
 */
export function createReviewAheadSession(filter: CardFilter, days: number): StudySession {
  return {
    kind: 'ahead',
    buildQueue: (state, scope) =>
      buildReviewAheadQueue(state, {
        days,
        nowMs: scope.nowMs,
        tzOffsetMinutes: scope.tzOffsetMinutes,
        ...(scope.deckId !== undefined ? { deckId: scope.deckId } : {}),
        ...(!isCardFilterEmpty(filter) ? { filter } : {}),
      }),
  };
}
