import { useEffect, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import {
  DEFAULT_REMINDER_CONFIG,
  formatReminderTime,
  loadReminderConfig,
  parseReminderTime,
  saveReminderConfig,
  type StudyReminderConfig,
} from './reminderConfig.ts';

const PERMISSION_DENIED_MESSAGE =
  'Notifications are turned off for Flashcards. Allow them in your device settings, then turn reminders on again.';

/**
 * Settings › Study Preferences: daily study reminder (Phase 13, default off). Native shells ask
 * for notification permission only when the user turns reminders on; the PWA never asks, it shows
 * an in-app badge on the Study tab instead. Same layout before and after the config loads.
 */
export function StudyRemindersSetting() {
  const { platform } = useApp();
  const [config, setConfig] = useState<StudyReminderConfig>(DEFAULT_REMINDER_CONFIG);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isNative = platform.getStudyReminderScheduler !== undefined;

  useEffect(() => {
    let active = true;
    void loadReminderConfig(platform.storage).then((loaded) => {
      if (active) setConfig(loaded);
    });
    return () => {
      active = false;
    };
  }, [platform]);

  const save = async (next: StudyReminderConfig) => {
    setConfig(next);
    await saveReminderConfig(platform.storage, next);
  };

  /** Asks for permission (native only); false when the OS refused. */
  const ensurePermission = async (): Promise<boolean> => {
    if (!platform.getStudyReminderScheduler) return true;
    const scheduler = await platform.getStudyReminderScheduler();
    return (await scheduler.requestPermission()) === 'granted';
  };

  const handleToggle = async (enabled: boolean) => {
    setMessage(null);
    if (!enabled) {
      await save({ ...config, enabled: false });
      return;
    }
    setBusy(true);
    try {
      if (await ensurePermission()) await save({ ...config, enabled: true });
      else setMessage(PERMISSION_DENIED_MESSAGE);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleTime = (value: string) => {
    const time = parseReminderTime(value);
    if (time) void save({ ...config, ...time });
  };

  return (
    <div data-testid="study-reminders-setting" className="flex flex-col gap-2 text-sm">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="study-reminder-toggle">
          <span className="block font-medium">Daily study reminder</span>
          <span className="block text-xs text-[var(--muted)]">
            {isNative
              ? 'A notification at this time with the number of cards due.'
              : 'After this time, the Study tab shows how many cards are due. Notifications need the mobile or desktop app.'}
          </span>
        </label>
        <input
          id="study-reminder-toggle"
          type="checkbox"
          data-testid="study-reminder-toggle"
          checked={config.enabled}
          disabled={busy}
          onChange={(e) => void handleToggle(e.target.checked)}
          className="h-4 w-4 shrink-0"
        />
      </div>
      <label className="flex items-center justify-between gap-4 text-xs text-[var(--muted)]">
        <span>Reminder time</span>
        <input
          type="time"
          step={60}
          data-testid="study-reminder-time"
          value={formatReminderTime(config)}
          onChange={(e) => handleTime(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm text-[var(--fg)]"
        />
      </label>
      {message && (
        <p
          role="alert"
          data-testid="study-reminder-message"
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
        >
          {message}
        </p>
      )}
    </div>
  );
}
