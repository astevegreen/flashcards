import {
  DEFAULT_AZURE_VOICES,
  DEFAULT_GOOGLE_VOICES,
  getTotalAppliedEventCount,
  type DrawingMode,
  type RatingButtonMode,
} from '@flash/core';
import { canCreateOrImportDeck, canUseCloudSync } from '@flash/core/license';
import type { InstalledPackInfo, TtsProviderKind } from '@flash/platform';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { lazyWithRetry } from '../lazy/lazyWithRetry.tsx';
import { describeImportError } from '../components/describeImportError.ts';
import { LanguagesCard } from '../components/LanguagesCard.tsx';
import { StudyRemindersSetting } from '../reminders/StudyRemindersSetting.tsx';
import { isExportCancelled } from '../export/exportCancelled.ts';
import { useApp, type SyncUiStatus } from '../state/AppContext.tsx';
import { useActiveLanguages } from '../state/useActiveLanguages.ts';
import { CardTextSizeSetting } from '../study/CardTextSizeSetting.tsx';
import { LeechAutoSuspendSetting } from '../study/LeechSettings.tsx';
import { OneDriveSyncButtons } from '../sync/OneDriveSyncButtons.tsx';
import {
  SettingsAddDevice,
  SettingsSyncMyDevices,
  useActiveSyncChoice,
} from '../sync/SettingsSyncBlocks.tsx';
import { describeSyncProvider } from '../sync/syncProviderLabel.ts';

const LazyPackManagerPanel = lazyWithRetry(() =>
  import('../packs/PackManagerPanel.tsx').then((m) => ({ default: m.PackManagerPanel })),
);
const LazyAboutLicensesCard = lazyWithRetry(() =>
  import('../packs/AboutLicensesCard.tsx').then((m) => ({ default: m.AboutLicensesCard })),
);
const LazyBackupsPanel = lazyWithRetry(() =>
  import('../backups/BackupsPanel.tsx').then((m) => ({ default: m.BackupsPanel })),
);
const LazyCheckPanel = lazyWithRetry(() =>
  import('../check/CheckPanel.tsx').then((m) => ({ default: m.CheckPanel })),
);
const LazyUnlockAndSunsetCard = lazyWithRetry(() =>
  import('../packs/UnlockAndSunsetCard.tsx').then((m) => ({ default: m.UnlockAndSunsetCard })),
);

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

const TTS_LANGUAGES = [
  { key: 'ja', label: 'Japanese (ja)' },
  { key: 'zh-Hans', label: 'Mandarin (zh-Hans)' },
  { key: 'ko', label: 'Korean (ko)' },
  { key: 'en', label: 'English (en)' },
] as const;

const DRAWING_LANGUAGES = [
  { key: 'ja', label: 'Japanese (ja)', defaultMode: 'graded' as DrawingMode },
  { key: 'zh-Hans', label: 'Mandarin (zh-Hans)', defaultMode: 'graded' as DrawingMode },
  { key: 'ko', label: 'Korean / Hanja (ko)', defaultMode: 'lookup' as DrawingMode },
] as const;

export function SettingsScreen() {
  const {
    platform,
    state,
    stateVersion,
    meta,
    entitlement,
    audio,
    syncState,
    syncNow,
    connectGoogleDrive,
    connectDropbox,
    connectLocalFolder,
    reconnectLocalFolder,
    connectICloud,
    disconnectSync,
    emitEvents,
    getEventFactory,
    updatePreferences,
    loadSampleDecks,
    markBackupCompleted,
    resetLocalData,
  } = useApp();
  // Language-specific options show only for languages in use (UX #2); saved values are kept.
  const active = useActiveLanguages();
  const ttsLanguages = TTS_LANGUAGES.filter((l) => active.hasLanguage(l.key));
  const drawingLanguages = DRAWING_LANGUAGES.filter((l) => active.hasLanguage(l.key));

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [installedPacks, setInstalledPacks] = useState<InstalledPackInfo[]>([]);

  // Audio & BYO Cloud TTS form state (API key stays strictly device-local)
  const [ttsProviderDraft, setTtsProviderDraft] = useState<TtsProviderKind>(
    audio.ttsConfig.provider,
  );
  const [ttsApiKeyDraft, setTtsApiKeyDraft] = useState(audio.ttsConfig.apiKey ?? '');
  const [ttsAzureRegionDraft, setTtsAzureRegionDraft] = useState(audio.ttsConfig.azureRegion ?? '');
  const [voiceDrafts, setVoiceDrafts] = useState<Record<string, string>>({
    ja: state.preferences.tts_voices?.['ja'] ?? '',
    'zh-Hans': state.preferences.tts_voices?.['zh-Hans'] ?? '',
    ko: state.preferences.tts_voices?.['ko'] ?? '',
    en: state.preferences.tts_voices?.['en'] ?? '',
  });
  const [ttsTestLangChoice, setTtsTestLangChoice] = useState('ko');
  const ttsTestLang = ttsLanguages.some((l) => l.key === ttsTestLangChoice)
    ? ttsTestLangChoice
    : (ttsLanguages[0]?.key ?? ttsTestLangChoice);
  const [ttsTestBusy, setTtsTestBusy] = useState(false);
  const [ttsTestMessage, setTtsTestMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [voiceListTick, setVoiceListTick] = useState(0);

  useEffect(() => {
    setTtsProviderDraft(audio.ttsConfig.provider);
    setTtsApiKeyDraft(audio.ttsConfig.apiKey ?? '');
    setTtsAzureRegionDraft(audio.ttsConfig.azureRegion ?? '');
  }, [audio.ttsConfig]);

  const syncedVoicesKey = JSON.stringify(state.preferences.tts_voices ?? {});
  useEffect(() => {
    setVoiceDrafts({
      ja: state.preferences.tts_voices?.['ja'] ?? '',
      'zh-Hans': state.preferences.tts_voices?.['zh-Hans'] ?? '',
      ko: state.preferences.tts_voices?.['ko'] ?? '',
      en: state.preferences.tts_voices?.['en'] ?? '',
    });
    // Only resync drafts when synced `tts_voices` actually changes (not on unrelated state ticks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedVoicesKey]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const synth = window.speechSynthesis;
    const bump = () => setVoiceListTick((t) => t + 1);
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', bump);
      return () => synth.removeEventListener('voiceschanged', bump);
    }
    return undefined;
  }, []);

  const audioClipCount = useMemo(() => {
    let count = 0;
    for (const entry of state.media.values()) {
      if (entry.mime.startsWith('audio/')) count += 1;
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion]);

  const localVoiceSummary = useMemo(() => {
    void voiceListTick;
    const speech = platform.deviceSpeech;
    if (!speech || !speech.isAvailable()) return null;
    const langs = ['ja', 'zh-Hans', 'ko', 'en'] as const;
    return langs.map((lang) => {
      const localCount = speech.listVoices(lang).filter((v) => v.localService).length;
      return { lang, localCount };
    });
  }, [platform.deviceSpeech, voiceListTick]);

  const handleSaveTtsSettings = async () => {
    setError(null);
    try {
      if (ttsProviderDraft === 'azure' && !/^[a-z0-9-]{2,32}$/i.test(ttsAzureRegionDraft.trim())) {
        setError('Please enter a valid Azure region (e.g. eastus or koreacentral).');
        return;
      }
      await audio.saveTtsConfig({
        provider: ttsProviderDraft,
        ...(ttsApiKeyDraft.trim() ? { apiKey: ttsApiKeyDraft.trim() } : {}),
        ...(ttsProviderDraft === 'azure' && ttsAzureRegionDraft.trim()
          ? { azureRegion: ttsAzureRegionDraft.trim().toLowerCase() }
          : {}),
      });
      // Persist synced per-language voice overrides via PreferencesChanged
      const voicePatch: Record<string, string> = {};
      for (const lang of ['ja', 'zh-Hans', 'ko', 'en'] as const) {
        const nextVal = (voiceDrafts[lang] ?? '').trim();
        const prevVal = (state.preferences.tts_voices?.[lang] ?? '').trim();
        if (nextVal !== prevVal) {
          voicePatch[lang] = nextVal;
        }
      }
      if (Object.keys(voicePatch).length > 0) {
        updatePreferences({ tts_voices: voicePatch });
      }
      setStatus('Audio & TTS settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleClearTtsKey = async () => {
    setError(null);
    await audio.clearTtsKey();
    setTtsProviderDraft('none');
    setTtsApiKeyDraft('');
    setTtsAzureRegionDraft('');
    setTtsTestMessage(null);
    setStatus('Cleared device-local Cloud TTS API key.');
  };

  const handleTestVoice = async () => {
    setTtsTestBusy(true);
    setTtsTestMessage(null);
    try {
      const draftVoice = (voiceDrafts[ttsTestLang] ?? '').trim();
      const res = await audio.testTtsVoice(ttsTestLang, {
        config: {
          provider: ttsProviderDraft,
          ...(ttsApiKeyDraft.trim() ? { apiKey: ttsApiKeyDraft.trim() } : {}),
          ...(ttsProviderDraft === 'azure' && ttsAzureRegionDraft.trim()
            ? { azureRegion: ttsAzureRegionDraft.trim().toLowerCase() }
            : {}),
        },
        ...(draftVoice ? { voiceOverride: draftVoice } : {}),
      });
      setTtsTestMessage({ ok: res.ok, text: res.message });
    } catch (err) {
      setTtsTestMessage({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTtsTestBusy(false);
    }
  };

  const isSyncConnected = syncState.provider !== 'none';
  const activeSyncChoice = useActiveSyncChoice();
  const providerLabel = describeSyncProvider(syncState.provider, syncState.localFolderName);

  const handleSyncNow = async () => {
    const syncGate = canUseCloudSync(entitlement);
    if (!syncGate.allowed) {
      setError(syncGate.reason ?? 'Cloud sync requires the one-time Unlock upgrade.');
      return;
    }
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
    const syncGate = canUseCloudSync(entitlement);
    if (!syncGate.allowed) {
      setError(syncGate.reason ?? 'Cloud sync requires the one-time Unlock upgrade.');
      return;
    }
    setError(null);
    try {
      await connectGoogleDrive();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConnectDropbox = async () => {
    const syncGate = canUseCloudSync(entitlement);
    if (!syncGate.allowed) {
      setError(syncGate.reason ?? 'Cloud sync requires the one-time Unlock upgrade.');
      return;
    }
    setError(null);
    try {
      await connectDropbox();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConnectLocalFolder = async () => {
    const syncGate = canUseCloudSync(entitlement);
    if (!syncGate.allowed) {
      setError(syncGate.reason ?? 'Cloud sync requires the one-time Unlock upgrade.');
      return;
    }
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

  const handleConnectICloud = async () => {
    const syncGate = canUseCloudSync(entitlement);
    if (!syncGate.allowed) {
      setError(syncGate.reason ?? 'Cloud sync requires the one-time Unlock upgrade.');
      return;
    }
    setSyncBusy(true);
    setError(null);
    try {
      await connectICloud();
      setStatus('Connected iCloud Drive sync.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncBusy(false);
    }
  };

  const handleReconnectLocalFolder = async () => {
    const syncGate = canUseCloudSync(entitlement);
    if (!syncGate.allowed) {
      setError(syncGate.reason ?? 'Cloud sync requires the one-time Unlock upgrade.');
      return;
    }
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
      // A `.flashpkg` any build can import, plus the review history a restore needs.
      const { saveFullBackupFile } = await import('../backups/backupRunner.ts');
      const dateStamp = new Date().toISOString().slice(0, 10);
      await saveFullBackupFile(platform, state, {
        deviceId: meta?.deviceId ?? platform.deviceId,
        ...(meta?.collectionId !== undefined ? { collectionId: meta.collectionId } : {}),
        fileName: `flashcards-backup-${dateStamp}.flashpkg`,
      });
      await markBackupCompleted();
      setStatus('Backup exported successfully.');
      setError(null);
    } catch (err) {
      if (isExportCancelled(err)) {
        setStatus('Export cancelled.');
        setError(null);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRestoreBackup = async () => {
    try {
      const picked = await platform.files.pickFile({ accept: '.flashpkg,.zip' });
      if (!picked) return;
      const { importFlashpkg } = await import('@flash/core/flashpkg');
      const result = importFlashpkg(picked.bytes, state, getEventFactory());
      const activeDeckCount = [...state.decks.values()].filter((d) => !d.archived).length;
      const netNewDecks = Math.max(0, result.decksImported - result.upgradedDecks);
      if (netNewDecks > 0) {
        const deckGate = canCreateOrImportDeck(activeDeckCount + netNewDecks - 1, entitlement);
        if (!deckGate.allowed) {
          setError(deckGate.reason ?? 'Free tier deck limit reached.');
          return;
        }
      }
      for (const media of result.extractedMedia) {
        await platform.storage.putMedia({
          hash: media.hash,
          mime: media.mime,
          bytes: media.bytes,
        });
      }
      if (result.events.length > 0) {
        emitEvents(result.events);
      }
      setStatus(
        `Restored "${result.manifest.name}" (${result.decksImported} deck(s), ${result.notesImported} note(s), ${result.pagesImported} page(s)).`,
      );
      setError(null);
    } catch (err) {
      setError(describeImportError(err));
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
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 whitespace-pre-line text-sm text-rose-700 dark:text-rose-300"
        >
          {error}
        </div>
      )}

      {/* Cloud Sync (Phase 2) */}
      <div
        data-testid="cloud-sync-card"
        className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        {/* The pill's text changes while syncing; it must not wrap onto its own line and shift the page. */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Cloud Sync</h2>
            <p className="text-xs text-[var(--muted)]">
              Provider: <strong className="text-[var(--fg)]">{providerLabel}</strong>
            </p>
          </div>
          <span
            data-testid="sync-status-pill"
            className={`min-w-[6.5rem] shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-center text-xs font-semibold ${getSyncPillClass(syncState.status)}`}
          >
            {syncState.collectionChoice ? 'Choose below' : formatSyncStatusLabel(syncState.status)}
          </span>
        </div>

        {syncState.readOnly && !syncState.collectionChoice && (
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

        {platform.secureStorageWarning && (
          <div
            role="status"
            data-testid="secure-storage-warning"
            className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
          >
            {platform.secureStorageWarning}
          </div>
        )}

        {/* One status per line on phones: "Never" -> a full date must not re-wrap this row and
            shift everything below it (e.g. a pack's Install button) when the first sync lands. */}
        <div className="grid gap-1 text-xs text-[var(--muted)] sm:flex sm:flex-wrap sm:items-center sm:gap-x-4">
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

        {/* Phase 14: one "Sync my devices" button, then every provider below it. */}
        <SettingsSyncMyDevices />

        <div className="flex flex-wrap gap-2 pt-1">
          {isSyncConnected && (
            <button
              type="button"
              data-testid="sync-now-btn"
              disabled={syncBusy || syncState.status === 'syncing'}
              onClick={() => void handleSyncNow()}
              className="min-w-[5.5rem] rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {syncState.status === 'syncing' ? 'Syncing…' : 'Sync Now'}
            </button>
          )}

          {syncState.provider !== 'google_drive' && activeSyncChoice !== 'google_drive' && (
            <button
              type="button"
              data-testid="connect-google-drive-btn"
              disabled={!platform.googleOAuthConfigured || syncBusy}
              onClick={() => void handleConnectGoogleDrive()}
              title={
                platform.googleOAuthConfigured
                  ? 'Sync privately via your Google Drive App Data folder'
                  : 'Configure VITE_GOOGLE_CLIENT_ID to enable Google Drive sync'
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

          {platform.dropboxConfigured &&
            syncState.provider !== 'dropbox' &&
            activeSyncChoice !== 'dropbox' && (
              <button
                type="button"
                data-testid="connect-dropbox-btn"
                disabled={syncBusy}
                onClick={() => void handleConnectDropbox()}
                title="Sync privately via your Dropbox App Folder"
                className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
              >
                Connect Dropbox
              </button>
            )}

          {syncState.provider === 'dropbox' && syncState.status === 'reconnect_required' && (
            <button
              type="button"
              disabled={syncBusy}
              onClick={() => void handleConnectDropbox()}
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300"
            >
              Reconnect Dropbox
            </button>
          )}

          <OneDriveSyncButtons
            busy={syncBusy}
            hideConnect={activeSyncChoice === 'onedrive'}
            onError={setError}
          />

          {platform.iCloudSyncSupported &&
            syncState.provider !== 'icloud' &&
            activeSyncChoice !== 'icloud' && (
              <button
                type="button"
                data-testid="connect-icloud-btn"
                disabled={syncBusy}
                onClick={() => void handleConnectICloud()}
                title="Sync privately via your iCloud Drive (no sign-in needed)"
                className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
              >
                Use iCloud Drive
              </button>
            )}

          {platform.supportsLocalFolderSync &&
            syncState.provider !== 'local_folder' &&
            activeSyncChoice !== 'local_folder' && (
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

        {/* Phase 14: "Add a device" (QR code + link) and the add-device collection check. */}
        <SettingsAddDevice />
      </div>

      {/* Languages (UX #2): which languages' options are shown */}
      <LanguagesCard active={active} />

      {/* Study preferences */}
      <div className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-sm font-semibold">Study Preferences</h2>

        <StudyRemindersSetting />

        <label className="flex items-center justify-between gap-4 text-sm">
          <div className="min-w-0">
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
            className="min-w-0 max-w-[55%] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm"
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

        {active.hasFeature('pinyin') && (
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
        )}

        {active.hasLanguage('ja') && (
          <label className="flex items-center justify-between gap-4 text-sm">
            <div>
              <div className="font-medium">Japanese typed mode: Hiragana = Katakana</div>
              <div className="text-xs text-[var(--muted)]">
                Accept hiragana and katakana interchangeably when grading typed Japanese answers.
              </div>
            </div>
            <input
              type="checkbox"
              checked={state.preferences.ja_kana_equivalent ?? true}
              onChange={(e) => updatePreferences({ ja_kana_equivalent: e.target.checked })}
              className="h-4 w-4"
            />
          </label>
        )}

        {active.hasFeature('tones') && (
          <label className="flex items-center justify-between gap-4 text-sm">
            <div>
              <div className="font-medium">Mandarin typed mode: Ignore tones</div>
              <div className="text-xs text-[var(--muted)]">
                Accept pinyin without tone marks or tone numbers when grading typed Mandarin
                answers.
              </div>
            </div>
            <input
              type="checkbox"
              checked={state.preferences.zh_ignore_tones ?? false}
              onChange={(e) => updatePreferences({ zh_ignore_tones: e.target.checked })}
              className="h-4 w-4"
            />
          </label>
        )}

        <LeechAutoSuspendSetting />
      </div>

      <CardTextSizeSetting />

      {/* Audio & TTS (Phase 5, §7) */}
      <div
        data-testid="audio-tts-card"
        className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <div>
          <h2 className="text-sm font-semibold">Audio &amp; TTS</h2>
          <p className="text-xs text-[var(--muted)]">
            Resolution order: attached clip → cached/synced TTS → optional BYO cloud TTS → offline
            device voice.
          </p>
        </div>

        <label className="flex items-center justify-between gap-4 text-sm">
          <div>
            <div className="font-medium">Auto-play audio during study</div>
            <div className="text-xs text-[var(--muted)]">
              Automatically speak cards on front (Recognition) or reveal (Production). Listen mode
              always auto-plays.
            </div>
          </div>
          <input
            type="checkbox"
            data-testid="auto-play-audio-toggle"
            checked={state.preferences.auto_play_audio ?? false}
            onChange={(e) => updatePreferences({ auto_play_audio: e.target.checked })}
            className="h-4 w-4"
          />
        </label>

        <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold">Cloud TTS Provider (Optional BYO Key)</div>
              <div className="text-[11px] text-[var(--muted)]">
                API keys are stored strictly on this device and are <strong>never synced</strong> or
                exported. Synthesized MP3 clips are cached &amp; synced so other devices play them
                offline.
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-[var(--muted)]">Provider</span>
              <select
                aria-label="Cloud TTS Provider"
                data-testid="tts-provider-select"
                value={ttsProviderDraft}
                onChange={(e) => setTtsProviderDraft(e.target.value as TtsProviderKind)}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--fg)]"
              >
                <option value="none">None (Device TTS only)</option>
                <option value="google">Google Cloud TTS</option>
                <option value="azure">Azure AI Speech</option>
              </select>
            </label>

            {ttsProviderDraft !== 'none' && (
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-[var(--muted)]">
                  {ttsProviderDraft === 'google'
                    ? 'Google Cloud API Key (device-local)'
                    : 'Azure Subscription Key (device-local)'}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  data-testid="tts-api-key-input"
                  value={ttsApiKeyDraft}
                  onChange={(e) => setTtsApiKeyDraft(e.target.value)}
                  placeholder={
                    ttsProviderDraft === 'google' ? 'AIza…' : 'Azure Speech subscription key'
                  }
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--fg)]"
                />
              </label>
            )}

            {ttsProviderDraft === 'azure' && (
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-[var(--muted)]">Azure Region</span>
                <input
                  type="text"
                  autoComplete="off"
                  data-testid="tts-azure-region-input"
                  value={ttsAzureRegionDraft}
                  onChange={(e) => setTtsAzureRegionDraft(e.target.value)}
                  placeholder="eastus, koreacentral, japaneast…"
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--fg)]"
                />
              </label>
            )}
          </div>

          {ttsProviderDraft !== 'none' && (
            <div className="flex flex-col gap-2 pt-1">
              <div className="text-[11px] font-medium text-[var(--muted)]">
                Optional Voice ID overrides (synced across devices; leave blank for neural defaults)
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {ttsLanguages.map(({ key, label }) => {
                  const placeholder =
                    ttsProviderDraft === 'google'
                      ? (DEFAULT_GOOGLE_VOICES[key] ?? '')
                      : (DEFAULT_AZURE_VOICES[key] ?? '');
                  return (
                    <label key={key} className="flex flex-col gap-0.5 text-[11px]">
                      <span className="text-[var(--muted)]">{label}</span>
                      <input
                        type="text"
                        data-testid={`tts-voice-${key}`}
                        value={voiceDrafts[key] ?? ''}
                        onChange={(e) =>
                          setVoiceDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        placeholder={placeholder}
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              data-testid="tts-save-btn"
              onClick={() => void handleSaveTtsSettings()}
              className="rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              Save Audio Settings
            </button>
            {(audio.ttsConfig.apiKey || ttsProviderDraft !== 'none') && (
              <button
                type="button"
                data-testid="tts-clear-btn"
                onClick={() => void handleClearTtsKey()}
                className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400"
              >
                Clear Key
              </button>
            )}
          </div>
        </div>

        {/* Live Voice Test */}
        {ttsLanguages.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Test voice language"
              data-testid="tts-test-lang-select"
              value={ttsTestLang}
              onChange={(e) => setTtsTestLangChoice(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--fg)]"
            >
              {ttsLanguages.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="tts-test-btn"
              disabled={ttsTestBusy}
              onClick={() => void handleTestVoice()}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
            >
              {ttsTestBusy ? 'Playing…' : '🔊 Test Voice'}
            </button>
            {ttsTestMessage && (
              <span
                data-testid="tts-test-status"
                className={`text-xs ${
                  ttsTestMessage.ok
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                {ttsTestMessage.text}
              </span>
            )}
          </div>
        )}

        {/* Diagnostics Strip */}
        <div className="grid gap-1 border-t border-[var(--border)] pt-2 text-[11px] text-[var(--muted)] sm:flex sm:flex-wrap sm:items-center sm:gap-x-4">
          <span>
            Cached / attached audio clips:{' '}
            <strong data-testid="audio-clip-count" className="text-[var(--fg)]">
              {audioClipCount}
            </strong>
          </span>
          {localVoiceSummary ? (
            <span>
              Offline device voices:{' '}
              {localVoiceSummary.map((v, idx) => (
                <span key={v.lang}>
                  {idx > 0 ? ', ' : ''}
                  <strong className="text-[var(--fg)]">{v.lang}</strong>:{v.localCount}
                </span>
              ))}
            </span>
          ) : (
            <span>Device speech synthesis: unavailable</span>
          )}
        </div>
      </div>

      {/* Drawing & Handwriting Modes (Phase 6, §6.4) */}
      {active.hasFeature('handwriting') && drawingLanguages.length > 0 && (
        <div
          data-testid="drawing-settings-card"
          className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
        >
          <div>
            <h2 className="text-sm font-semibold">Drawing &amp; Handwriting</h2>
            <p className="text-xs text-[var(--muted)]">
              Choose per-language behavior for Draw layouts: <strong>Graded</strong> (stroke-order
              quiz via Hanzi Writer), <strong>Lookup</strong> (freehand draw-to-lookup, Hanja
              default), or <strong>Off</strong>.
            </p>
          </div>

          {drawingLanguages.map(({ key, label, defaultMode }) => {
            const currentMode = state.preferences.drawing_modes?.[key] ?? defaultMode;
            return (
              <label key={key} className="flex items-center justify-between gap-4 text-sm">
                <span className="min-w-0 font-medium">{label}</span>
                <select
                  aria-label={`Drawing mode for ${label}`}
                  data-testid={`drawing-mode-select-${key}`}
                  value={currentMode}
                  onChange={(e) =>
                    updatePreferences({
                      drawing_modes: { [key]: e.target.value as DrawingMode },
                    })
                  }
                  className="min-w-0 max-w-[55%] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm"
                >
                  <option value="graded">Graded (Stroke Quiz)</option>
                  <option value="lookup">Lookup (Handwriting Match)</option>
                  <option value="off">Off</option>
                </select>
              </label>
            );
          })}
        </div>
      )}

      {/* Offline Dictionaries & Stroke Packs (Phase 6, §6.3) */}
      <Suspense
        fallback={
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-xs text-[var(--muted)]">
            Loading pack manager…
          </div>
        }
      >
        <LazyPackManagerPanel onInstalledPacksChanged={setInstalledPacks} />
        <LazyUnlockAndSunsetCard />
        <LazyAboutLicensesCard installedPacks={installedPacks} />
      </Suspense>

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

      <Suspense fallback={null}>
        <LazyBackupsPanel />
        <LazyCheckPanel />
      </Suspense>

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
