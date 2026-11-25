import { isCardFilterEmpty, type PracticeOrder, type StudyMethod } from '@flash/core';
import { setStudyFilter, type ActiveStudyFilter } from './filterStore.ts';
import {
  getInstalledPractice,
  getSessionStudyOptions,
  setInstalledPractice,
  setSessionStudyMethod,
  setSessionStudyOrder,
} from './studyOptionsStore.ts';
import { createPracticeSession, type SessionDeps } from './studySessions.ts';

/**
 * Study options actions (lazy chunk, §8): start / end / reorder the Study screen's practice
 * session and set the session's scheduled-queue order. Practice reuses the custom-study practice
 * session (`PracticeRecorded`, never FSRS) as the running `ActiveStudyFilter.session`.
 */

export interface StudyOptionsContext {
  deps: SessionDeps;
  /** The Study deck selection. */
  deckId: string | undefined;
  /** The filter / custom study session running now (in scope). */
  studyFilter: ActiveStudyFilter | undefined;
  /** The scheduled-queue order now (session choice, else the Settings default). */
  scheduleOrder: PracticeOrder;
}

/** The filter each Study-screen practice session replaced, restored on "Spaced repetition". */
const practiceBases = new WeakMap<ActiveStudyFilter, ActiveStudyFilter | undefined>();

/** Practice over the running schedule-mode filter (if any), else over the selected deck(s). */
export function startPractice(ctx: StudyOptionsContext, order: PracticeOrder, auto: boolean) {
  const base = ctx.studyFilter?.session ? undefined : ctx.studyFilter;
  const filter = base?.filter ?? {};
  const next: ActiveStudyFilter = {
    label: base ? `${base.label} · Practice` : 'Practice',
    filter,
    scope: base?.scope ?? { deckId: ctx.deckId },
    session: createPracticeSession(ctx.deps, filter, order),
  };
  practiceBases.set(next, base);
  setInstalledPractice({ active: next, deckId: ctx.deckId, auto });
  setStudyFilter(next);
}

/** Ends a practice session, back to the schedule-mode filter it replaced (if any). */
export function endPractice(active: ActiveStudyFilter): void {
  setInstalledPractice(undefined);
  if (practiceBases.has(active)) {
    setStudyFilter(practiceBases.get(active));
    return;
  }
  // Practice started from Custom study: keep its decks / categories on the normal schedule.
  setStudyFilter(
    isCardFilterEmpty(active.filter)
      ? undefined
      : {
          label: 'Filter',
          filter: active.filter,
          ...(active.scope === undefined ? {} : { scope: active.scope }),
        },
  );
}

/**
 * Settings "Default study method" for a deck selection: applies until the user picks a method this
 * session, and never replaces a filter or custom study session the user started.
 */
export function applyDefaultMethod(ctx: StudyOptionsContext, method: StudyMethod): void {
  if (getSessionStudyOptions(ctx.deckId)?.method !== undefined) return;
  const installed = getInstalledPractice();
  const alreadyStarted = installed !== undefined && installed.deckId === ctx.deckId;
  if (method === 'practice' && !ctx.studyFilter && !alreadyStarted) {
    startPractice(ctx, ctx.scheduleOrder, true);
  } else if (method === 'schedule' && ctx.studyFilter && installed?.active === ctx.studyFilter) {
    if (installed.auto) endPractice(ctx.studyFilter);
  }
}

/** The user picked a method on the chip (this session only). */
export function chooseMethod(ctx: StudyOptionsContext, next: StudyMethod): void {
  const practice = ctx.studyFilter?.session?.kind === 'practice' ? ctx.studyFilter : undefined;
  if ((next === 'practice') === Boolean(practice)) return;
  setSessionStudyMethod(ctx.deckId, next);
  if (next === 'practice') {
    startPractice(ctx, ctx.scheduleOrder, false);
    return;
  }
  if (!practice) return;
  const order = practice.session?.order;
  if (order === 'deck' || order === 'random') setSessionStudyOrder(ctx.deckId, order);
  endPractice(practice);
}

/** The user picked an order: reorders the running practice session, else the scheduled queue. */
export function chooseOrder(ctx: StudyOptionsContext, next: PracticeOrder): void {
  const active = ctx.studyFilter;
  const practice = active?.session?.kind === 'practice' ? active.session : undefined;
  if (active && practice) {
    if (!practice.withOrder) return;
    const updated: ActiveStudyFilter = { ...active, session: practice.withOrder(next) };
    if (practiceBases.has(active)) practiceBases.set(updated, practiceBases.get(active));
    const installed = getInstalledPractice();
    if (installed?.active === active) setInstalledPractice({ ...installed, active: updated });
    setStudyFilter(updated);
  } else if (next !== 'hardest') {
    setSessionStudyOrder(ctx.deckId, next);
  }
}
