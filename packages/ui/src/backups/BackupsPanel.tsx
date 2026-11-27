import {
  anyBackupHoldsMedia,
  BACKUP_ARCHIVE_LIMITS,
  FULL_BACKUP_MAX_MEDIA_BYTES,
  planBackupRestore,
  type RestoreSummary,
} from '@flash/core/backup';
import type { StoredBackupInfo } from '@flash/platform';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { useSyncState } from '../state/syncStateStore.ts';
import { tooLargeMessage } from '../components/pickedFileLimit.ts';
import {
  applyRestore,
  listSyncFolderBackups,
  loadBackupSettings,
  loadBackupStatus,
  prepareRestore,
  readSyncFolderBackup,
  saveBackupSettings,
  saveStoredBackupFile,
  openBackupStore,
  takeBackup,
  type BackupContext,
  type PreparedRestore,
  type SyncFolderBackupEntry,
  type TakeBackupResult,
} from './backupRunner.ts';
import { isExportCancelled } from '../export/exportCancelled.ts';

/**
 * Settings > Automatic backups: the rolling snapshots on this device, "Back up now", the optional
 * copy in the sync folder, and restores (always previewed and confirmed: a restore appends new
 * events, so it reaches every synced device).
 */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function kindLabel(info: StoredBackupInfo): string {
  if (info.reason === 'pre-restore') return 'Before a restore';
  if (info.reason === 'manual') return info.media_included ? 'Manual, with media' : 'Manual';
  return info.media_included ? 'Weekly, with media' : 'Daily';
}

function backupSavedMessage(result: TakeBackupResult): string {
  if (result.syncCopyError) {
    return `Backup saved on this device. The sync-folder copy failed: ${result.syncCopyError}`;
  }
  if (result.syncCopyWritten) return 'Backup saved on this device and in the sync folder.';
  return 'Backup saved on this device.';
}

/** Says when no kept snapshot holds the images and audio (none yet, or too much for one). */
function backupMediaNotice(
  state: { media: ReadonlyMap<string, { size: number }> },
  backups: readonly StoredBackupInfo[],
): string | null {
  if (state.media.size === 0 || anyBackupHoldsMedia(backups)) return null;
  let total = 0;
  for (const m of state.media.values()) total += Math.max(0, m.size);
  if (total > FULL_BACKUP_MAX_MEDIA_BYTES) {
    return `Your images and audio (${formatBytes(total)}) are too large for the automatic backups, so none of them holds media. Download a backup to keep a copy with media, or use sync.`;
  }
  return 'None of the kept backups holds your images and audio yet. The weekly backup will; Download adds them to any backup.';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Plain-language lines for the confirm step; empty when the backup matches the collection. */
export function describeRestoreSummary(s: RestoreSummary): string[] {
  const lines: string[] = [];
  const add = (n: number, text: string) => {
    if (n > 0) lines.push(text);
  };
  add(s.decksAdded, `Bring back ${plural(s.decksAdded, 'deck')}`);
  add(s.decksChanged, `Change ${plural(s.decksChanged, 'deck')} back`);
  add(s.decksArchived, `Archive ${plural(s.decksArchived, 'deck')} added since`);
  add(
    s.notesAdded + s.notesRestored,
    `Bring back ${plural(s.notesAdded + s.notesRestored, 'note')}`,
  );
  add(s.notesChanged, `Change ${plural(s.notesChanged, 'note')} back`);
  add(s.notesArchived, `Archive ${plural(s.notesArchived, 'note')} the backup doesn't have`);
  add(s.reviewsAdded, `Bring back ${plural(s.reviewsAdded, 'review')}`);
  add(s.reviewsUndone, `Undo ${plural(s.reviewsUndone, 'review')}`);
  const other =
    s.noteTypesChanged +
    s.layoutsChanged +
    s.fsrsParamsChanged +
    s.suspensionsChanged +
    s.pagesChanged +
    s.coursesChanged +
    s.descriptionsChanged +
    s.presetsChanged +
    s.foldersChanged +
    s.groupingsChanged +
    (s.preferencesChanged ? 1 : 0);
  add(
    other,
    `Change ${plural(other, 'other setting')} back (layouts, pages, courses, presets, folders, options)`,
  );
  return lines;
}

interface PendingRestore {
  label: string;
  prepared: PreparedRestore;
}

export function BackupsPanel() {
  const {
    platform,
    state,
    stateVersion,
    meta,
    emitEvents,
    getEventFactory,
    markBackupCompleted,
    syncNow,
    clearUndoStack,
  } = useApp();
  const syncState = useSyncState();
  const storage = platform.storage;
  const supported = typeof storage.openBackupStore === 'function';
  const [backups, setBackups] = useState<StoredBackupInfo[]>([]);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [syncCopy, setSyncCopy] = useState(false);
  const [remote, setRemote] = useState<SyncFolderBackupEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const providerRef = useRef(syncState.provider);
  providerRef.current = syncState.provider;
  const syncing = syncState.provider !== 'none';

  const ctx = useCallback(
    (): BackupContext => ({
      platform,
      getState: () => stateRef.current,
      getMeta: () => {
        if (!metaRef.current) throw new Error('This device is still starting up. Try again.');
        return metaRef.current;
      },
      getSyncProvider: () => providerRef.current,
    }),
    [platform],
  );

  const refresh = useCallback(async () => {
    const store = await openBackupStore(storage);
    if (store) setBackups(await store.list());
    setLastError((await loadBackupStatus(storage))?.lastError ?? null);
  }, [storage]);

  useEffect(() => {
    void refresh();
    void loadBackupSettings(storage).then((s) => setSyncCopy(s.syncFolderCopy));
    void storage.requestPersistence().then(setPersisted, () => setPersisted(false));
  }, [refresh, storage]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await task();
    } catch (err) {
      if (isExportCancelled(err)) setStatus('Export cancelled.');
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const backUpNow = () =>
    run(async () => {
      try {
        const result = await takeBackup(ctx(), 'manual');
        if (result) setStatus(backupSavedMessage(result));
      } finally {
        await refresh();
      }
    });

  /** Pulls other devices' changes first, so the plan starts from the newest collection. */
  const syncFirst = async (): Promise<void> => {
    if (!syncing) return;
    try {
      await syncNow();
    } catch {
      // Planning still works on this device's view; the confirmation says so.
    }
  };

  const preview = async (label: string, bytes: Uint8Array) => {
    await syncFirst();
    setPending({ label, prepared: prepareRestore(ctx(), bytes) });
  };

  const previewLocal = (info: StoredBackupInfo) =>
    run(async () => {
      const bytes = await (await openBackupStore(storage))?.getBytes(info.backup_id);
      if (!bytes) throw new Error('This backup is no longer on the device.');
      await preview(new Date(info.created_at).toLocaleString(), bytes);
    });

  const previewRemote = (entry: SyncFolderBackupEntry) =>
    run(async () => {
      const bytes = await readSyncFolderBackup(ctx(), entry.path);
      const when = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : entry.path;
      await preview(`${when} (sync folder, ${entry.deviceId})`, bytes);
    });

  const previewFile = () =>
    run(async () => {
      const picked = await platform.files.pickFile({
        accept: '.flashpkg,.zip',
        maxBytes: BACKUP_ARCHIVE_LIMITS.maxCompressedBytes,
      });
      if (!picked) return;
      const tooLarge = tooLargeMessage(
        picked,
        BACKUP_ARCHIVE_LIMITS.maxCompressedBytes,
        'to restore',
      );
      if (tooLarge) throw new Error(tooLarge);
      try {
        await preview(picked.name, picked.bytes);
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)} A .flashpkg without review history can still be imported with "Restore .flashpkg".`,
          { cause: err },
        );
      }
    });

  // The preview follows the collection (a sync can land while it is open).
  useEffect(() => {
    setPending((p) =>
      p
        ? {
            label: p.label,
            prepared: {
              read: p.prepared.read,
              plan: planBackupRestore(stateRef.current, p.prepared.read.state),
            },
          }
        : p,
    );
  }, [stateVersion]);

  const confirmRestore = () =>
    run(async () => {
      if (!pending) return;
      await syncFirst();
      const result = await applyRestore(
        { ...ctx(), emitEvents, getEventFactory },
        pending.prepared.read,
      );
      // Undoing a review from before the restore would act on a collection that changed.
      clearUndoStack();
      setPending(null);
      await refresh();
      const parts = [
        result.eventCount === 0
          ? 'Nothing to restore: the collection already matches this backup.'
          : `Restored the backup from ${pending.label}.`,
      ];
      if (result.preRestoreBackup) {
        parts.push('A backup of the collection as it was is at the top of the list.');
      }
      if (result.mediaMissing > 0) {
        parts.push(
          `${plural(result.mediaMissing, 'media file')} isn't on this device${syncing ? ' yet; sync may bring it' : ''}.`,
        );
      }
      setStatus(parts.join(' '));
    });

  const download = (info: StoredBackupInfo) =>
    run(async () => {
      const stamp = new Date(info.created_at).toISOString().slice(0, 10);
      const { missingMedia: missing } = await saveStoredBackupFile(
        platform,
        info,
        `flashcards-backup-${stamp}.flashpkg`,
      );
      await markBackupCompleted();
      setStatus(
        missing > 0
          ? `Saved. ${plural(missing, 'media file')} wasn't on this device and is not in the file.`
          : 'Saved. Keep the file somewhere other than this device.',
      );
    });

  const toggleSyncCopy = (on: boolean) =>
    run(async () => {
      await saveBackupSettings(storage, { syncFolderCopy: on });
      setSyncCopy(on);
    });

  const showRemote = () =>
    run(async () => {
      setRemote(await listSyncFolderBackups(ctx()));
    });

  if (!supported) return null;
  const mediaNotice = backupMediaNotice(state, backups);
  const lines = pending ? describeRestoreSummary(pending.prepared.plan.summary) : [];
  const summary = pending?.prepared.plan.summary;
  const differentCollection =
    pending?.prepared.read.manifest.collection_id !== undefined &&
    meta?.collectionId !== undefined &&
    pending.prepared.read.manifest.collection_id !== meta.collectionId;

  return (
    <div
      data-testid="backups-panel"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Automatic backups</h2>
          <p className="text-xs text-[var(--muted)]">
            A snapshot of your collection is saved on this device about once a day you use the app.
            The newest 14 are kept; one a week also holds your images and audio.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void backUpNow()}
            className="rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            Back up now
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void previewFile()}
            className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            Restore from a file…
          </button>
        </div>
      </div>

      {lastError && (
        <p
          data-testid="backup-last-error"
          className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          The last backup was not saved. {lastError}
        </p>
      )}
      {mediaNotice && (
        <p
          data-testid="backup-media-notice"
          className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          {mediaNotice}
        </p>
      )}

      {persisted === false && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          This browser may clear its storage, backups included, when space runs low. Download a
          backup now and then, or turn on sync.
        </p>
      )}

      <label className="flex items-center justify-between gap-4 text-sm">
        <div>
          <div className="font-medium">Also keep a copy in the sync folder</div>
          <div className="text-xs text-[var(--muted)]">
            {syncing
              ? 'One copy a day for the last 7 days, without media (the sync folder already has it).'
              : 'Connect sync first.'}
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="Also keep a copy in the sync folder"
          data-testid="backup-sync-copy-toggle"
          disabled={busy || !syncing}
          checked={syncCopy && syncing}
          onChange={(e) => void toggleSyncCopy(e.target.checked)}
          className="h-4 w-4"
        />
      </label>

      {status && (
        <output className="block text-xs text-emerald-700 dark:text-emerald-300">{status}</output>
      )}
      {error && (
        <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}

      {pending && summary && (
        <section
          aria-labelledby="restore-confirm-title"
          data-testid="restore-confirm"
          className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
        >
          <h3 id="restore-confirm-title" className="text-sm font-semibold">
            Restore the backup from {pending.label}?
          </h3>
          {lines.length === 0 ? (
            <p>Your collection already matches this backup.</p>
          ) : (
            <ul className="list-disc pl-5">
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          {differentCollection && (
            <p className="font-medium">This backup is from a different collection.</p>
          )}
          {summary.reviewsNotRestorable > 0 && (
            <p>
              {plural(summary.reviewsNotRestorable, 'review')} in the backup were undone since and
              stay undone.
            </p>
          )}
          {summary.reviewsKept > 0 && (
            <p>
              {plural(summary.reviewsKept, 'review')} made after this backup stay in your history.
            </p>
          )}
          <p className="text-[var(--muted)]">
            {syncing
              ? 'The restore is saved as new changes, so it reaches every device that syncs with this collection. Edits made on a device that has not synced yet may survive it. '
              : ''}
            Nothing is deleted: notes and decks the backup doesn't have are archived. A backup of
            the collection as it is now is saved first, so you can go back.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || lines.length === 0}
              onClick={() => void confirmRestore()}
              className="rounded-xl bg-[var(--accent)] px-3 py-2 font-semibold text-white disabled:opacity-50"
            >
              {syncing ? 'Restore on all devices' : 'Restore'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPending(null)}
              className="rounded-xl border border-[var(--border)] px-3 py-2 font-semibold hover:bg-[var(--surface-2)]"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {backups.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">No backups on this device yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--border)]" data-testid="backup-list">
          {backups.map((b) => (
            <li
              key={b.backup_id}
              data-testid="backup-row"
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
            >
              <div className="min-w-0">
                <div className="font-medium text-[var(--fg)]">
                  {new Date(b.created_at).toLocaleString()} · {kindLabel(b)}
                </div>
                <div className="text-[var(--muted)]">
                  {plural(b.counts.decks, 'deck')} · {plural(b.counts.notes, 'note')} ·{' '}
                  {plural(b.counts.reviews, 'review')} · {formatBytes(b.size_bytes)}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void previewLocal(b)}
                  className="rounded-lg border border-[var(--border)] px-2.5 py-1 font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
                >
                  Restore…
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void download(b)}
                  className="rounded-lg border border-[var(--border)] px-2.5 py-1 font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
                >
                  Download
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {syncing && (
        <div className="flex flex-col gap-2">
          <SyncFolderCopies
            remote={remote}
            busy={busy}
            thisDeviceId={meta?.deviceId}
            onShow={() => void showRemote()}
            onRestore={(entry) => void previewRemote(entry)}
          />
        </div>
      )}
    </div>
  );
}

interface SyncFolderCopiesProps {
  remote: SyncFolderBackupEntry[] | null;
  busy: boolean;
  thisDeviceId: string | undefined;
  onShow: () => void;
  onRestore: (entry: SyncFolderBackupEntry) => void;
}

/** The snapshot copies in the sync folder, listed on request. */
function SyncFolderCopies({
  remote,
  busy,
  thisDeviceId,
  onShow,
  onRestore,
}: Readonly<SyncFolderCopiesProps>) {
  if (remote === null) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={onShow}
        className="self-start rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        Show copies in the sync folder
      </button>
    );
  }
  if (remote.length === 0) {
    return <p className="text-xs text-[var(--muted)]">No copies in the sync folder yet.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-[var(--border)]" data-testid="sync-backup-list">
      {remote.map((r) => (
        <li key={r.path} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
          <div className="min-w-0">
            <div className="font-medium text-[var(--fg)]">
              {r.updatedAt ? new Date(r.updatedAt).toLocaleString() : r.path}
            </div>
            <div className="text-[var(--muted)]">
              From {r.deviceId === thisDeviceId ? 'this device' : r.deviceId} ·{' '}
              {formatBytes(r.size)}
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRestore(r)}
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            Restore…
          </button>
        </li>
      ))}
    </ul>
  );
}
