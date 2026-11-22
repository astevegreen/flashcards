import { isValidReminderTime, type ReminderTimeOfDay } from '@flash/core';
import type { Storage } from '@flash/platform';

/**
 * Phase 13 study reminders. Device-local (a phone and a desktop each choose their own time and
 * permission), so the setting lives in the device key-value store, not in the synced event log.
 */
export interface StudyReminderConfig extends ReminderTimeOfDay {
  enabled: boolean;
}

export const DEFAULT_REMINDER_CONFIG: StudyReminderConfig = { enabled: false, hour: 19, minute: 0 };

const KV_KEY = 'study_reminders';

function toConfig(raw: unknown): StudyReminderConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_REMINDER_CONFIG;
  const obj = raw as Partial<Record<keyof StudyReminderConfig, unknown>>;
  const time = { hour: Number(obj.hour), minute: Number(obj.minute) };
  if (!isValidReminderTime(time)) return DEFAULT_REMINDER_CONFIG;
  return { enabled: obj.enabled === true, ...time };
}

const listeners = new Set<(config: StudyReminderConfig) => void>();

export async function loadReminderConfig(storage: Storage): Promise<StudyReminderConfig> {
  try {
    return toConfig(await storage.getKv(KV_KEY));
  } catch {
    return DEFAULT_REMINDER_CONFIG;
  }
}

export async function saveReminderConfig(
  storage: Storage,
  config: StudyReminderConfig,
): Promise<void> {
  const clean = toConfig(config);
  await storage.setKv(KV_KEY, clean);
  for (const listener of listeners) listener(clean);
}

/** Notifies the reminder runtime when Settings changes the configuration. */
export function onReminderConfigChange(
  listener: (config: StudyReminderConfig) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `HH:MM` for an `<input type="time">`. */
export function formatReminderTime(time: ReminderTimeOfDay): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

/** Parses `HH:MM` (seconds ignored); `undefined` when invalid. */
export function parseReminderTime(value: string): ReminderTimeOfDay | undefined {
  const [h, m] = value.split(':');
  if (!h || !m) return undefined;
  const time = { hour: Number(h), minute: Number(m) };
  return isValidReminderTime(time) ? time : undefined;
}

export function reminderNotificationText(dueCount: number): { title: string; body: string } {
  return {
    title: 'Time to study',
    body: dueCount === 1 ? '1 card is due.' : `${dueCount} cards are due.`,
  };
}
