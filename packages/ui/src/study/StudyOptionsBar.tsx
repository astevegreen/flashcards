import type { StudyMethod } from '@flash/core';
import { Suspense, useEffect, useId, useRef, useState } from 'react';
import { lazyWithRetry } from '../lazy/lazyWithRetry.tsx';
import { retryImport } from '../lazy/retryImport.ts';
import { useApp } from '../state/AppContext.tsx';
import type { ActiveStudyFilter } from './filterStore.ts';
import type { StudyOptionsContext } from './studyOptionsActions.ts';
import {
  getInstalledPractice,
  METHOD_LABELS,
  openSessionStudyOptions,
  ORDER_LABELS,
  setInstalledPractice,
  setSessionStudyMethod,
  useSessionStudyOptions,
} from './studyOptionsStore.ts';

// The popover body and the practice session code load on first use (§8).
const LazyStudyOptionsPanel = lazyWithRetry(() =>
  import('./StudyOptionsPanel.tsx').then((m) => ({ default: m.StudyOptionsPanel })),
);

const supportsPopover =
  typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');

export interface StudyOptionsBarProps {
  /** The Study deck selection (`activeDeckId`). */
  deckId: string | undefined;
  /** The filter / custom study session running now (in scope). */
  studyFilter: ActiveStudyFilter | undefined;
}

/**
 * Study screen "Method · Order" chip (session only). Spaced repetition runs today's FSRS queue in
 * the chosen order (`buildStudyQueue` `order`); Practice runs a cram session over the current deck
 * and filter (`PracticeRecorded`, never FSRS). Choices reset when the deck selection changes or
 * the app restarts; Settings › Study Preferences holds the defaults (the default method applies
 * until the user picks one this session). Only the chip is on the critical path (§8).
 */
export function StudyOptionsBar({ deckId, studyFilter }: Readonly<StudyOptionsBarProps>) {
  const { state, getEventFactory, emitEvents } = useApp();
  const options = useSessionStudyOptions(deckId);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const session = studyFilter?.session;
  const practice = session?.kind === 'practice' ? session : undefined;
  const scheduleOrder = options?.order ?? state.preferences.study_order ?? 'deck';
  const method: StudyMethod = practice ? 'practice' : 'schedule';
  const order = practice ? practice.order : scheduleOrder;
  const ctx: StudyOptionsContext = {
    deps: { state, getEventFactory, emitEvents },
    deckId,
    studyFilter,
    scheduleOrder,
  };

  // A practice session this chip started was ended elsewhere (its × chip, "Clear filter"):
  // that is a choice of the schedule for this session.
  useEffect(() => {
    const installed = getInstalledPractice();
    if (installed === undefined || installed.active === studyFilter) return;
    setInstalledPractice(undefined);
    if (installed.deckId === deckId) setSessionStudyMethod(deckId, 'schedule');
  }, [studyFilter, deckId]);

  // Settings "Default study method", whenever the deck selection or the default changes.
  const defaultMethod = state.preferences.study_method ?? 'schedule';
  useEffect(() => {
    openSessionStudyOptions(deckId);
    const installed = getInstalledPractice();
    const needed =
      defaultMethod === 'practice'
        ? !studyFilter
        : studyFilter !== undefined && installed?.active === studyFilter;
    if (!needed || options?.method !== undefined) return;
    retryImport(() => import('./studyOptionsActions.ts'))
      .then((m) => m.applyDefaultMethod(ctx, defaultMethod))
      .catch(() => {
        // A failed chunk load leaves the current session running.
      });
    // Only when the deck selection or the saved default changes (session semantics).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId, defaultMethod]);

  if (session?.kind === 'ahead') return null;

  const close = () => {
    if (supportsPopover) panelRef.current?.hidePopover();
    else setOpen(false);
    triggerRef.current?.blur();
  };
  // Closing returns focus to the chip; drop it so Space / Enter reveal the card again.
  const onToggle = (e: React.ToggleEvent<HTMLDivElement>) => {
    if (e.newState === 'open') setOpen(true);
    else if (document.activeElement === triggerRef.current) triggerRef.current?.blur();
  };

  const orderLabel = order === undefined ? '' : ORDER_LABELS[order];
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="study-options-btn"
        popoverTarget={supportsPopover ? panelId : undefined}
        onClick={supportsPopover ? undefined : () => setOpen((v) => !v)}
        title={`This session: ${METHOD_LABELS[method]}${orderLabel ? `, ${orderLabel}` : ''}`}
        className="max-w-[11rem] truncate rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--fg)] hover:bg-[var(--surface-2)]"
      >
        {method === 'practice' ? 'Practice' : 'SRS'}
        {orderLabel ? ` · ${orderLabel}` : ''}
      </button>
      <div
        id={panelId}
        ref={panelRef}
        popover="auto"
        onToggle={onToggle}
        hidden={supportsPopover ? undefined : !open}
        role="group"
        aria-label="Study options for this session"
        data-testid="study-options-panel"
        className="w-60 max-w-[90vw] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-[var(--fg)] shadow-lg supports-[position-area:block-end]:inset-auto supports-[position-area:block-end]:m-0 supports-[position-area:block-end]:mt-1 supports-[position-area:block-end]:[position-area:block-end_span-inline-end] supports-[position-area:block-end]:[position-try-fallbacks:flip-block,flip-inline]"
      >
        {open && (
          <Suspense fallback={<div className="py-2 text-[var(--muted)]">Loading…</div>}>
            <LazyStudyOptionsPanel ctx={ctx} method={method} order={order} onDone={close} />
          </Suspense>
        )}
      </div>
    </>
  );
}
