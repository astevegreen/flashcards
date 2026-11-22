import type { CollectionState } from '../events/replay.ts';
import type { Card } from '../model/types.ts';
import { cardFilterToStatsFilter } from '../study/custom-study.ts';
import {
  filterCards,
  isCardFilterEmpty,
  normalizeCardFilter,
  type CardFilterContext,
} from '../study/filter.ts';
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

/** Default number of rows in the Stats screen "Hardest cards" list and MCP `get_weak_cards`. */
export const HARDEST_CARDS_DEFAULT_LIMIT = 20;

/**
 * The hardest reviewed cards of a Phase 9 `CardFilter` selection (lapses desc, stability asc,
 * difficulty desc, card id: `compareHardestCards`, the Trouble cards ranking). The single entry
 * point shared by the Stats screen "Hardest cards" list and MCP `get_weak_cards`, so both list
 * the same cards in the same order for the same filter. A filter's own `performance.hardest`
 * still caps the result when it is smaller than `limit`.
 */
export function computeHardestCards(
  state: CollectionState,
  rawFilter: unknown,
  ctx: CardFilterContext,
  limit: number = HARDEST_CARDS_DEFAULT_LIMIT,
): Card[] {
  const filter = normalizeCardFilter(rawFilter);
  const cap = Math.max(1, Math.floor(limit));
  const hardest = Math.min(cap, filter.performance?.hardest ?? cap);
  return filterCards(state, { ...filter, performance: { ...filter.performance, hardest } }, ctx);
}
