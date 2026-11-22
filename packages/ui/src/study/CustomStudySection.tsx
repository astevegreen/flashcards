import {
  buildReviewAheadQueue,
  filterCards,
  isCardFilterEmpty,
  MAX_EXTRA_NEW_CARDS,
  MAX_REVIEW_AHEAD_DAYS,
  uuidv7,
  type CardFilter,
  type CollectionState,
} from '@flash/core';
import { useMemo, useState } from 'react';
import type { ActiveStudyFilter } from './filterStore.ts';
import {
  createPracticeSession,
  createReviewAheadSession,
  type SessionDeps,
} from './studySessions.ts';

const BTN =
  'shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-40';
const INPUT =
  'w-16 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs tabular-nums';

function clampInt(raw: string, max: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(1, Math.min(max, n)) : 1;
}

export interface CustomStudySectionProps {
  state: CollectionState;
  stateVersion: number;
  deps: SessionDeps;
  /** Decks in scope (`[]` = every deck). */
  deckIds: readonly string[];
  /** Decks + categories chosen in the panel. */
  filter: CardFilter;
  onStart: (active: ActiveStudyFilter) => void;
  onDone: () => void;
}

/**
 * Custom study (Phase 9): review ahead, extra new cards today and practice / cram for the
 * panel's scope. Only "extra new cards" and practice answers write events; review ahead answers
 * are ordinary FSRS reviews.
 */
export function CustomStudySection({
  state,
  stateVersion,
  deps,
  deckIds,
  filter,
  onStart,
  onDone,
}: CustomStudySectionProps) {
  const [aheadDays, setAheadDays] = useState(3);
  const [extraNew, setExtraNew] = useState(10);

  const counts = useMemo(() => {
    const nowMs = Date.now();
    const tzOffsetMinutes = -new Date(nowMs).getTimezoneOffset();
    return {
      ahead: buildReviewAheadQueue(state, {
        days: aheadDays,
        nowMs,
        tzOffsetMinutes,
        ...(!isCardFilterEmpty(filter) ? { filter } : {}),
      }).counts.total,
      practice: filterCards(state, filter, { nowMs, tzOffsetMinutes, excludeSuspended: true })
        .length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, aheadDays, filter]);

  const raiseNewLimit = () => {
    const nowMs = Date.now();
    deps.emitEvents([
      deps.getEventFactory().create(
        'NewCardLimitRaised',
        {
          raise_id: uuidv7(nowMs),
          deck_ids: [...deckIds],
          extra: extraNew,
          raised_at: nowMs,
          tz_offset: -new Date(nowMs).getTimezoneOffset(),
        },
        nowMs,
      ),
    ]);
    // With categories chosen, study exactly those new cards; otherwise the normal queue shows them.
    if (filter.categories) onStart({ label: `+${extraNew} new`, filter });
    else onDone();
  };

  return (
    <section aria-label="Custom study" data-testid="custom-study" className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
        Custom study
      </h3>

      <div className="flex items-center gap-2 text-xs">
        <label className="flex flex-1 items-center gap-2">
          <span className="font-medium">Review ahead</span>
          <input
            type="number"
            min={1}
            max={MAX_REVIEW_AHEAD_DAYS}
            aria-label="Review ahead days"
            data-testid="custom-ahead-days"
            value={aheadDays}
            onChange={(e) => setAheadDays(clampInt(e.target.value, MAX_REVIEW_AHEAD_DAYS))}
            className={INPUT}
          />
          <span className="text-[var(--muted)]">days</span>
        </label>
        <button
          type="button"
          data-testid="custom-ahead-start"
          disabled={counts.ahead === 0}
          onClick={() =>
            onStart({
              label: `Review ahead ${aheadDays}d`,
              filter,
              session: createReviewAheadSession(filter, aheadDays),
            })
          }
          className={BTN}
        >
          Start <span data-testid="custom-ahead-count">{counts.ahead}</span>
        </button>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <label className="flex flex-1 items-center gap-2">
          <span className="font-medium">Extra new cards today</span>
          <input
            type="number"
            min={1}
            max={MAX_EXTRA_NEW_CARDS}
            aria-label="Extra new cards today"
            data-testid="custom-extra-new-count"
            value={extraNew}
            onChange={(e) => setExtraNew(clampInt(e.target.value, MAX_EXTRA_NEW_CARDS))}
            className={INPUT}
          />
        </label>
        <button
          type="button"
          data-testid="custom-extra-new-apply"
          onClick={raiseNewLimit}
          className={BTN}
        >
          Add
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 text-xs">
        <span>
          <span className="font-medium">Practice (cram)</span>{' '}
          <span className="text-[var(--muted)]">every card in scope, no effect on scheduling</span>
        </span>
        <button
          type="button"
          data-testid="custom-practice-start"
          disabled={counts.practice === 0}
          onClick={() =>
            onStart({
              label: 'Practice',
              filter,
              session: createPracticeSession(deps, filter),
            })
          }
          className={BTN}
        >
          Start <span data-testid="custom-practice-count">{counts.practice}</span>
        </button>
      </div>
    </section>
  );
}
