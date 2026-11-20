import { getTotalAppliedEventCount, type RatingButtonMode } from '@flash/core';
import { useState } from 'react';
import { useApp, type SyncUiStatus } from '../state/AppContext.tsx';

function formatSyncStatusLabel(status: SyncUiStatus): string {
  switch (status) {
    case 'disconnected':
      return 'Not connected';
    case 'idle':
      return 'Idle';
    case 'syncing':
      return 'Syncing…';
    case 'synced':
      return 'Synced';
    case 'offline':
      return 'Offline (queued)';
    case 'reconnect_required':
      return 'Reconnect required';
    case 'upgrade_required':
      return 'Update required (read-only)';
    case 'error':
      return 'Error';
  }
}

function getSyncPillClass(status: SyncUiStatus): string {
  switch (status) {
    case 'synced':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'syncing':
      return 'bg-sky-500/15 text-sky-700 dark:text-sky-300';
    case 'offline':
    case 'reconnect_required':
    case 'upgrade_required':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'error':
      return 'bg-rose-500/15 text-rose-700 dark:text-rose-300';
    default:
      return 'bg-[var(--surface-2)] text-[var(--muted)]';
  }
}

export function SettingsScreen() {
  const {
    platform,
    state,
    meta,
    syncState,
    syncNow,
    connectGoogleDrive,
    connectLocalFolder,
    reconnectLocalFolder,
    disconnectSync,
    emitEvents,
    getEventFactory,
    updatePreferences,
    loadSampleDecks,
    markBackupCompleted,
    resetLocalData,
  } = useApp();

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);

  const isSyncConnected = syncState.provider !== 'none';
  const providerLabel =
    syncState.provider === 'google_drive'
      ? 'Google Drive (App Data)'
      : syncState.provider === 'local_folder'
        ? `Local Folder (${syncState.localFolderName ?? 'Selected folder'})`
        : syncState.provider === 'dev_channel'
          ? 'Dev Channel (Local Tabs)'
          : 'Not Connected';

  const handleSyncNow = async () => {
    setSyncBusy(true);
    setError(null);
    try {
      await syncNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncBusy(false);
    }
  };

  const handleConnectGoogleDrive = async () => {
    setError(null);
    try {
      await connectGoogleDrive();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConnectLocalFolder = async () => {
    setSyncBusy(true);
    setError(null);
    try {
      const ok = await connectLocalFolder();
      if (ok) {
        setStatus('Connected local sync folder.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncBusy(false);
    }
  };

  const handleReconnectLocalFolder = async () => {
    setSyncBusy(true);
    setError(null);
    try {
      const ok = await reconnectLocalFolder();
      if (ok) {
        setStatus('Reconnected local sync folder.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncBusy(false);
    }
  };

  const handleDisconnectSync = async () => {
    setSyncBusy(true);
    setError(null);
    try {
      await disconnectSync();
      setStatus('Sync disconnected. Local data remains safely on this device.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncBusy(false);
    }
  };

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

      {/* Cloud Sync (Phase 2) */}
      <div
        data-testid="cloud-sync-card"
        className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Cloud Sync</h2>
            <p className="text-xs text-[var(--muted)]">
              Provider: <strong className="text-[var(--fg)]">{providerLabel}</strong>
            </p>
          </div>
          <span
            data-testid="sync-status-pill"
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${getSyncPillClass(syncState.status)}`}
          >
            {formatSyncStatusLabel(syncState.status)}
          </span>
        </div>

        {syncState.readOnly && (
          <div
            role="alert"
            className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
          >
            {syncState.errorMessage ??
              'This sync store uses a newer format version. Sync writes are paused in read-only mode until you update the app.'}
          </div>
        )}

        {!syncState.readOnly && syncState.errorMessage && (
          <div
            role="alert"
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
          >
            {syncState.errorMessage}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
          <span>
            Last synced:{' '}
            <strong data-testid="sync-last-synced" className="text-[var(--fg)]">
              {syncState.lastSyncedAt ? new Date(syncState.lastSyncedAt).toLocaleString() : 'Never'}
            </strong>
          </span>
          {isSyncConnected && (
            <span>
              Pending local events:{' '}
              <strong data-testid="sync-pending-count" className="text-[var(--fg)]">
                {syncState.pendingCount}
              </strong>
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          {isSyncConnected && (
            <button
              type="button"
              data-testid="sync-now-btn"
              disabled={syncBusy || syncState.status === 'syncing'}
              onClick={() => void handleSyncNow()}
              className="rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {syncState.status === 'syncing' ? 'Syncing…' : 'Sync Now'}
            </button>
          )}

          {syncState.provider !== 'google_drive' && (
            <button
              type="button"
              data-testid="connect-google-drive-btn"
              disabled={!platform.googleOAuthConfigured || syncBusy}
              onClick={() => void handleConnectGoogleDrive()}
              title={
                platform.googleOAuthConfigured
                  ? 'Sync privately via your Google Drive App Data folder'
                  : 'Configure VITE_GOOGLE_CLIENT_ID and VITE_TOKEN_HELPER_URL to enable Google Drive sync'
              }
              className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
            >
              Connect Google Drive
            </button>
          )}

          {syncState.provider === 'google_drive' && syncState.status === 'reconnect_required' && (
            <button
              type="button"
              disabled={syncBusy}
              onClick={() => void handleConnectGoogleDrive()}
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300"
            >
              Reconnect Google Drive
            </button>
          )}

          {platform.supportsLocalFolderSync && syncState.provider !== 'local_folder' && (
            <button
              type="button"
              data-testid="connect-local-folder-btn"
              disabled={syncBusy}
              onClick={() => void handleConnectLocalFolder()}
              className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
            >
              Connect Local Folder (PC)
            </button>
          )}

          {syncState.provider === 'local_folder' && syncState.status === 'reconnect_required' && (
            <button
              type="button"
              disabled={syncBusy}
              onClick={() => void handleReconnectLocalFolder()}
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300"
            >
              Reconnect Folder
            </button>
          )}

          {isSyncConnected && (
            <button
              type="button"
              data-testid="disconnect-sync-btn"
              disabled={syncBusy}
              onClick={() => void handleDisconnectSync()}
              className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

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
          Device ID:{' '}
          <code data-testid="device-id-value" className="font-mono text-[var(--fg)]">
            {meta?.deviceId ?? platform.deviceId}
          </code>{' '}
          · Events stored:{' '}
          <strong className="text-[var(--fg)]">{getTotalAppliedEventCount(state)}</strong>
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
