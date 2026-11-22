import type { CardFilter } from '@flash/core';
import { useSyncExternalStore } from 'react';

/**
 * Session-scoped (in-memory, per tab) Phase 9 filter state shared by Browse and Study:
 * - `browseFilter`: the decks / categories / card state currently selected in Browse, offered
 *   in Study as "Study this filter".
 * - `studyFilter`: the filter the current Study session runs (`undefined` = normal queue).
 *
 * Kept deliberately tiny because Study imports it on the critical path (§8). Persisting named
 * filters as synced Study Sets is a later Phase 9 slice.
 */
export interface ActiveStudyFilter {
  label: string;
  filter: CardFilter;
}

interface FilterStoreState {
  browseFilter: CardFilter;
  studyFilter: ActiveStudyFilter | undefined;
}

let current: FilterStoreState = { browseFilter: {}, studyFilter: undefined };
const listeners = new Set<() => void>();

function emit(next: FilterStoreState): void {
  current = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setBrowseFilter(filter: CardFilter): void {
  emit({ ...current, browseFilter: filter });
}

export function setStudyFilter(active: ActiveStudyFilter | undefined): void {
  emit({ ...current, studyFilter: active });
}

export function useBrowseFilter(): CardFilter {
  return useSyncExternalStore(subscribe, () => current.browseFilter);
}

export function useStudyFilter(): ActiveStudyFilter | undefined {
  return useSyncExternalStore(subscribe, () => current.studyFilter);
}
