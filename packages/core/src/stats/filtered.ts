import type { CollectionState } from '../events/replay.ts';
import { cardFilterToStatsFilter } from '../study/custom-study.ts';
import { isCardFilterEmpty, normalizeCardFilter } from '../study/filter.ts';
import {
  computeCollectionStats,
  type CollectionStats,
  type CollectionStatsOptions,
} from './stats.ts';

/**
 * Phase 11 statistics for a Phase 9 `CardFilter` (decks, categories, card state, performance).
 * The single entry point shared by the Stats screen and MCP `get_stats`, so both report the same
 * numbers for the same filter: the filter is normalized, then compiled by `cardFilterToStatsFilter`
 * (the same card selection as Browse and Study). An empty filter covers the whole collection.
 */
export function computeFilteredCollectionStats(
  state: CollectionState,
  rawFilter: unknown,
  options: Omit<CollectionStatsOptions, 'filter'>,
): CollectionStats {
  const filter = normalizeCardFilter(rawFilter);
  if (isCardFilterEmpty(filter)) return computeCollectionStats(state, options);
  const ctx = {
    nowMs: options.nowMs,
    tzOffsetMinutes: options.tzOffsetMinutes,
    ...(options.dayStartHour === undefined ? {} : { dayStartHour: options.dayStartHour }),
  };
  return computeCollectionStats(state, {
    ...options,
    filter: cardFilterToStatsFilter(state, filter, ctx),
  });
}
