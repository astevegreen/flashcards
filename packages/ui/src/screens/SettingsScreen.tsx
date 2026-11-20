import type { RatingButtonMode } from '@flash/core';
import { useState } from 'react';
import { useApp } from '../state/AppContext.tsx';

export function SettingsScreen() {
  const {
    platform,
    state,
    meta,
    emitEvents,
    getEventFactory,
    updatePreferences,
    loadSampleDecks,
    markBackupCompleted,
    resetLocalData,
  } = useApp();

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleExportBackup = async () => {
    try {
      const { exportFlashpkg } = await import('@flash/core/flashpkg');
      const bytes = exportFlashpkg(state, { name: 'Flashcards Full Backup' });
      const dateStamp = new Date().toISOString().slice(0, 10);
      await platform.files.downloadFile(
        `flashcards-backup-${dateStamp}.flashpkg`,
        bytes,
        'application/zip',
      );
      await markBackupCompleted();
      setStatus('Backup exported successfully.');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRestoreBackup = async () => {
    try {
      const picked = await platform.files.pickFile({ accept: '.flashpkg,.zip' });
      if (!picked) return;
      const { importFlashpkg } = await import('@flash/core/flashpkg');
      const result = importFlashpkg(picked.bytes, state, getEventFactory());
      if (result.events.length > 0) {
        emitEvents(result.events);
      }
      setStatus(
        `Restored "${result.manifest.name}" (${result.decksImported} deck(s), ${result.notesImported} note(s)).`,
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Settings</h1>
        <p className="text-xs text-[var(--muted)]">
          All settings are stored locally as events on this device.
        </p>
      </div>

      {status && (
        <div
          role="status"
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {status}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-700 dark:text-rose-300"
        >
          {error}
        </div>
      )}

      {/* Study preferences */}
      <div className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-sm font-semibold">Study Preferences</h2>

        <label className="flex items-center justify-between gap-4 text-sm">
          <div>
            <div className="font-medium">Rating buttons</div>
            <div className="text-xs text-[var(--muted)]">
              3 buttons (Again / Good / Easy) is recommended for FSRS.
            </div>
          </div>
          <select
            aria-label="Rating buttons mode"
            value={state.preferences.rating_button_mode}
            onChange={(e) =>
              updatePreferences({ rating_button_mode: e.target.value as RatingButtonMode })
            }
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm"
          >
            <option value="2">2 buttons (Again / Good)</option>
            <option value="3">3 buttons (Again / Good / Easy)</option>
            <option value="4">4 buttons (+ Hard)</option>
          </select>
        </label>

        <label className="flex items-center justify-between gap-4 text-sm">
          <div>
            <div className="font-medium">Study day starts at</div>
            <div className="text-xs text-[var(--muted)]">
              Local hour when daily queues and buried siblings roll over.
            </div>
          </div>
          <select
            aria-label="Study day start hour"
            value={state.preferences.day_start_hour}
            onChange={(e) => updatePreferences({ day_start_hour: Number(e.target.value) })}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm"
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center justify-between gap-4 text-sm">
          <div>
            <div className="font-medium">Pinyin tone colors</div>
            <div className="text-xs text-[var(--muted)]">
              Color Mandarin pinyin syllables by tone (1–5).
            </div>
          </div>
          <input
            type="checkbox"
            checked={state.preferences.pinyin_tone_colors}
            onChange={(e) => updatePreferences({ pinyin_tone_colors: e.target.checked })}
            className="h-4 w-4"
          />
        </label>
      </div>

      {/* Local Backup & Restore */}
      <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Local Backup (.flashpkg)</h2>
            <p className="text-xs text-[var(--muted)]">
              Last backup:{' '}
              {meta?.lastBackupAt ? new Date(meta.lastBackupAt).toLocaleString() : 'Never'}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleExportBackup()}
              className="rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white"
            >
              Export Backup
            </button>
            <button
              type="button"
              onClick={() => void handleRestoreBackup()}
              className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]"
            >
              Restore .flashpkg
            </button>
          </div>
        </div>
      </div>

      {/* Device / Dev Mode panel */}
      <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-sm font-semibold">Device & Data</h2>
        <div className="text-xs text-[var(--muted)]">
          Device ID: <code className="font-mono text-[var(--fg)]">{platform.deviceId}</code> ·
          Events stored: <strong className="text-[var(--fg)]">{state.appliedEventIds.size}</strong>
        </div>

        {platform.isDevMode && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[var(--muted)]">Dev device switcher:</span>
            <a
              href="?device=a"
              className="rounded-lg border border-[var(--border)] px-2.5 py-1 font-medium hover:bg-[var(--surface-2)]"
            >
              ?device=a
            </a>
            <a
              href="?device=b"
              className="rounded-lg border border-[var(--border)] px-2.5 py-1 font-medium hover:bg-[var(--surface-2)]"
            >
              ?device=b
            </a>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              loadSampleDecks();
              setStatus('Sample decks loaded.');
            }}
            className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]"
          >
            Load Sample Decks
          </button>
          <button
            type="button"
            onClick={() => {
              void resetLocalData().then(() => setStatus('Local device storage cleared.'));
            }}
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400"
          >
            Reset Local Device Data
          </button>
        </div>
      </div>
    </section>
  );
}
