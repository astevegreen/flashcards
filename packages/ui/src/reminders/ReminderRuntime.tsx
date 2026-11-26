import { buildStudyQueue, type CollectionState } from '@flash/core';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import {
  loadReminderConfig,
  onReminderConfigChange,
  type StudyReminderConfig,
} from './reminderConfig.ts';
import { createQuietTimer, type QuietTimer } from './quietTimer.ts';
import { rescheduleNativeReminders } from './reminderScheduling.ts';

/** Quiet period after the last change before native reminders are rescheduled. */
const RESCHEDULE_DEBOUNCE_MS = 10_000;
/** The web badge re-checks the due count this often while reminders are on. */
const BADGE_REFRESH_MS = 60_000;
/**
 * Quiet period after the last change before the web badge rebuilds the queue, so a study session
 * doesn't rebuild it after every rating (P9).
 */
export const BADGE_CHANGE_DEBOUNCE_MS = 2_000;

const localTzOffsetAt = (ms: number) => -new Date(ms).getTimezoneOffset();

/** Web badge: the due count once today's reminder time has passed (0 before it, or when off). */
export function webBadgeCount(
  config: StudyReminderConfig,
  state: CollectionState,
  nowMs: number,
): number {
  if (!config.enabled) return 0;
  const reminderAt = new Date(nowMs);
  reminderAt.setHours(config.hour, config.minute, 0, 0);
  if (nowMs < reminderAt.getTime()) return 0;
  return buildStudyQueue(state, { nowMs, tzOffsetMinutes: localTzOffsetAt(nowMs) }).counts.total;
}

export interface ReminderRuntimeProps {
  /** Due count for the in-app Study tab badge (PWA only; 0 hides it). */
  onBadgeChange: (count: number) => void;
}

/**
 * Phase 13 study reminders runtime (lazy-loaded by AppShell, renders nothing). Native shells get
 * OS notifications rescheduled with fresh due counts whenever the collection changes or the app
 * goes to the background; the PWA gets an in-app badge on the Study tab instead.
 */
export function ReminderRuntime({ onBadgeChange }: ReminderRuntimeProps) {
  const { platform, state, stateVersion } = useApp();
  const [config, setConfig] = useState<StudyReminderConfig | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state, stateVersion]);
  const isNative = platform.getStudyReminderScheduler !== undefined;

  useEffect(() => {
    let active = true;
    void loadReminderConfig(platform.storage).then((loaded) => {
      if (active) setConfig(loaded);
    });
    const unsubscribe = onReminderConfigChange(setConfig);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [platform]);

  // Native: serialize reschedules so an older plan never overwrites a newer one.
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!isNative || !config) return undefined;
    const run = () => {
      chainRef.current = chainRef.current
        .then(() => rescheduleNativeReminders(platform, config, stateRef.current))
        .catch((err: unknown) => console.warn('Study reminders could not be scheduled:', err));
    };
    run();
    const onHidden = () => {
      if (document.visibilityState === 'hidden') run();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [config, isNative, platform]);

  useEffect(() => {
    if (!isNative || !config?.enabled || stateVersion === 0) return undefined;
    const timer = window.setTimeout(() => {
      chainRef.current = chainRef.current
        .then(() => rescheduleNativeReminders(platform, config, stateRef.current))
        .catch((err: unknown) => console.warn('Study reminders could not be scheduled:', err));
    }, RESCHEDULE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [config, isNative, platform, stateVersion]);

  // Web: in-app badge only.
  useEffect(() => {
    if (isNative || !config?.enabled) {
      onBadgeChange(0);
      return undefined;
    }
    const evaluate = () => onBadgeChange(webBadgeCount(config, stateRef.current, Date.now()));
    evaluate();
    const interval = window.setInterval(evaluate, BADGE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [config, isNative, onBadgeChange]);

  // Web: after a change, once the collection has been quiet for a moment.
  const badgeTimerRef = useRef<QuietTimer | null>(null);
  useEffect(() => {
    if (isNative || !config?.enabled) return undefined;
    const timer = createQuietTimer(
      () => onBadgeChange(webBadgeCount(config, stateRef.current, Date.now())),
      BADGE_CHANGE_DEBOUNCE_MS,
    );
    badgeTimerRef.current = timer;
    return () => {
      timer.cancel();
      badgeTimerRef.current = null;
    };
  }, [config, isNative, onBadgeChange]);
  useEffect(() => {
    if (stateVersion !== 0) badgeTimerRef.current?.trigger();
  }, [stateVersion]);

  return null;
}
