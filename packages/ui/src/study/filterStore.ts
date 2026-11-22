import type {
  Card,
  CardFilter,
  CollectionState,
  ReviewRating,
  StudyQueueResult,
} from '@flash/core';
import { useSyncExternalStore } from 'react';

/**
 * Session-scoped (in-memory, per tab) Phase 9 filter state shared by Browse and Study:
 * - `browseFilter`: the decks / categories / card state currently selected in Browse, offered
 *   in Study as "Study this filter".
 * - `studyFilter`: the filter the current Study session runs (`undefined` = normal queue).
 *
 * Kept deliberately tiny because Study imports it on the critical path (§8). Named filters are
 * synced Study Sets (`StudySetSaved` events, see `@flash/core` custom-study); this store only
 * holds the session that is running now.
 */
export interface ActiveStudyFilter {
  label: string;
  filter: CardFilter;
  /**
   * The Study deck selection (`activeDeckId`) the filter was started under. Study drops the filter
   * as soon as that selection changes (Library "Study", deck archived, collection reset), so a stale
   * filter never intersects a different deck into an empty queue. Omitted = not bound to a deck.
   */
  scope?: { deckId: string | undefined };
  /**
   * Custom study session (practice / cram, review ahead). Created by the lazily loaded filter
   * panel, so its queue and answer logic stay off the study critical path (§8). Omitted = the
   * normal scheduled queue restricted to `filter`.
   */
  session?: StudySession;
}

export interface StudySession {
  kind: 'practice' | 'ahead';
  buildQueue: (
    state: CollectionState,
    scope: { deckId: string | undefined; nowMs: number; tzOffsetMinutes: number },
  ) => StudyQueueResult;
  /** Records an answer instead of `rateCard` (practice: `PracticeRecorded`, never FSRS). */
  rate?: (card: Card, rating: ReviewRating, durationMs: number) => void;
  /** Undoes this session's last answer instead of the last review. */
  undo?: () => boolean;
}

/**
 * Whether a started filter still applies: the Study deck selection is the one it was started
 * under, and every deck it names still exists and is not archived (a reset or replaced collection,
 * or an archived deck, otherwise leaves a filter that can never match).
 */
export function isStudyFilterInScope(
  active: ActiveStudyFilter,
  deckId: string | undefined,
  decks: ReadonlyMap<string, { archived?: boolean }>,
): boolean {
  if (active.scope !== undefined && active.scope.deckId !== deckId) return false;
  for (const id of active.filter.deckIds ?? []) {
    const deck = decks.get(id);
    if (!deck || deck.archived) return false;
  }
  return true;
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
