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
import {
  PERMISSION_DENIED_MESSAGE,
  reminderSettingDescription,
  toggleStudyReminders,
} from './reminderScheduling.ts';

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

  const handleToggle = async (enabled: boolean) => {
    setMessage(null);
    setBusy(true);
    try {
      const outcome = await toggleStudyReminders(platform, config, enabled);
      if (outcome.kind === 'saved') await save(outcome.config);
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
            {reminderSettingDescription(platform)}
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
