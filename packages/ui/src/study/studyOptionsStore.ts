import type { PracticeOrder, StudyMethod, StudyOrder } from '@flash/core';
import { useSyncExternalStore } from 'react';
import type { ActiveStudyFilter } from './filterStore.ts';

/**
 * Study-screen session options (in memory, per tab; tiny because Study imports it on the critical
 * path, §8). Bound to the Study deck selection they were made under: changing deck, or restarting
 * the app, returns to the saved Settings defaults. A Practice session itself runs as the
 * `ActiveStudyFilter.session` of `filterStore.ts`, which the deck switch already clears.
 */
export interface SessionStudyOptions {
  /** The Study deck selection (`activeDeckId`) these options belong to. */
  deckId: string | undefined;
  /** Scheduled-queue card order for this session (omitted = Settings defaults). */
  order?: StudyOrder;
  /** Method the user chose for this session (omitted = follow the Settings default). */
  method?: StudyMethod;
}

let current: SessionStudyOptions | undefined;
const listeners = new Set<() => void>();

export const METHOD_LABELS: Record<StudyMethod, string> = {
  schedule: 'Spaced repetition',
  practice: 'Practice',
};
export const ORDER_LABELS: Record<PracticeOrder, string> = {
  deck: 'Deck order',
  random: 'Random',
  hardest: 'Hardest first',
};

/** The practice session the Study options chip installed; `auto` = started by the Settings default. */
export interface InstalledPractice {
  active: ActiveStudyFilter;
  deckId: string | undefined;
  auto: boolean;
}

let installedPractice: InstalledPractice | undefined;

/** Lets the chip tell its own practice session from one the user ended or replaced elsewhere. */
export function getInstalledPractice(): InstalledPractice | undefined {
  return installedPractice;
}

export function setInstalledPractice(next: InstalledPractice | undefined): void {
  installedPractice = next;
}

function emit(next: SessionStudyOptions): void {
  current = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The session options of `deckId`'s selection, or `undefined` when none were made for it. */
export function getSessionStudyOptions(
  deckId: string | undefined,
): SessionStudyOptions | undefined {
  return current !== undefined && current.deckId === deckId ? current : undefined;
}

/** Starts empty session options for a deck selection (dropping another selection's choices). */
export function openSessionStudyOptions(deckId: string | undefined): void {
  if (getSessionStudyOptions(deckId) === undefined) emit({ deckId });
}

/** Sets (or, with `undefined`, clears back to the Settings default) the session card order. */
export function setSessionStudyOrder(deckId: string | undefined, order: StudyOrder | undefined) {
  const { method } = getSessionStudyOptions(deckId) ?? {};
  emit({
    deckId,
    ...(order === undefined ? {} : { order }),
    ...(method === undefined ? {} : { method }),
  });
}

/** Records the method the user chose for this session (the Settings default no longer applies). */
export function setSessionStudyMethod(deckId: string | undefined, method: StudyMethod) {
  const { order } = getSessionStudyOptions(deckId) ?? {};
  emit({ deckId, method, ...(order === undefined ? {} : { order }) });
}

/** The session options of `deckId`'s selection, or `undefined` when none were made for it. */
export function useSessionStudyOptions(
  deckId: string | undefined,
): SessionStudyOptions | undefined {
  const snapshot = useSyncExternalStore(subscribe, () => current);
  return snapshot !== undefined && snapshot.deckId === deckId ? snapshot : undefined;
}

/** The scheduled-queue order override of this session (`undefined` = Settings defaults). */
export function useSessionStudyOrder(deckId: string | undefined): StudyOrder | undefined {
  return useSessionStudyOptions(deckId)?.order;
}
