import type { CollectionArea, CollectionDifferenceKind } from '@flash/core/check';
import { useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { useSyncState } from '../state/syncStateStore.ts';
import {
  reAddUnlistedMedia,
  removeUnusedMedia,
  runDatabaseCheck,
  runMediaCheck,
  saveRebuiltCollection,
  type CheckContext,
  type DatabaseCheckResult,
  type MediaCheckResult,
} from './checkRunner.ts';

/**
 * Settings > Check collection: Check media (unused and missing files, with a confirmed removal
 * of the unused ones) and Check database (rebuild from the event log and list differences).
 */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

const AREA_LABELS: Record<CollectionArea, string> = {
  decks: 'Decks',
  notes: 'Notes',
  cards: 'Cards and schedules',
  reviews: 'Review history',
  undoneReviews: 'Undone reviews',
  fsrsParams: 'Scheduler settings',
  noteTypes: 'Note types',
  layouts: 'Card layouts',
  pages: 'Pages',
  courses: 'Courses',
  media: 'Media list',
  spokenAudio: 'Spoken audio',
  preferences: 'Options',
  otherEvents: 'Study sets and practice',
  pending: 'Waiting changes',
  registers: 'Sync bookkeeping',
};

const KIND_LABELS: Record<CollectionDifferenceKind, string> = {
  missing: 'missing',
  extra: 'not in the log',
  changed: 'different',
};

const SHOWN = 20;

export function CheckPanel() {
  const { platform, state, emitEvents, getEventFactory, syncNow, whenSaved } = useApp();
  const syncState = useSyncState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaCheckResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [database, setDatabase] = useState<DatabaseCheckResult | null>(null);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  // The checks read the newest committed collection through this, from handlers only.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const syncing = syncState.provider !== 'none';

  const ctx = (): CheckContext => ({ platform, getState: () => stateRef.current });

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const checkMediaNow = () =>
    run(async () => {
      setConfirmRemove(false);
      setMedia(await runMediaCheck(ctx()));
    });

  const removeNow = () =>
    run(async () => {
      const result = await removeUnusedMedia({ ...ctx(), emitEvents, getEventFactory });
      setConfirmRemove(false);
      const parts: string[] = [];
      if (result.removedFromCollection > 0) {
        parts.push(
          `Removed ${plural(result.removedFromCollection, 'unused file')} from the collection.`,
        );
      }
      if (result.filesDeleted > 0) {
        parts.push(`Freed ${plural(result.filesDeleted, 'file')} on this device.`);
      }
      if (result.filesKeptForBackups > 0) {
        parts.push(
          `${plural(result.filesKeptForBackups, 'file')} stay on this device until the backups that hold them roll off.`,
        );
      }
      setStatus(parts.length > 0 ? parts.join(' ') : 'Nothing to remove.');
      setMedia(await runMediaCheck(ctx()));
    });

  const reAddNow = () =>
    run(async () => {
      const added = await reAddUnlistedMedia({ ...ctx(), emitEvents, getEventFactory });
      setStatus(
        added > 0
          ? `Added ${plural(added, 'file')} back to the collection, so sync shares them again.`
          : 'Nothing to add back.',
      );
      setMedia(await runMediaCheck(ctx()));
    });

  const fetchMissingNow = () =>
    run(async () => {
      await syncNow();
      setMedia(await runMediaCheck(ctx()));
    });

  const checkDatabaseNow = () =>
    run(async () => {
      setConfirmRebuild(false);
      setDatabase(await runDatabaseCheck(ctx()));
    });

  const rebuildNow = () =>
    run(async () => {
      if (!database?.rebuilt) return;
      // Edits still on their way to storage land first, then the rebuild; the reload waits for
      // anything queued meanwhile (its snapshot writes skip: the rebuild stamp is newer).
      await whenSaved();
      await saveRebuiltCollection({ ...ctx(), deviceId: platform.deviceId }, database.rebuilt);
      await whenSaved();
      window.location.reload();
    });

  const report = media?.report;
  const removable = report ? report.unused.length : 0;
  const keptFiles = report ? report.unused.filter((f) => f.keepFileForBackups).length : 0;
  const comparison = database?.comparison;

  const describeMissing = (noteIds: string[], pageIds: string[], elsewhere: boolean): string => {
    const parts: string[] = [];
    if (noteIds.length > 0) {
      const decks = new Set<string>();
      for (const id of noteIds) {
        const deckId = state.notes.get(id)?.deck_id;
        const name = deckId ? state.decks.get(deckId)?.name : undefined;
        if (name) decks.add(name);
      }
      const where = decks.size > 0 ? ' in ' + [...decks].slice(0, 3).join(', ') : '';
      parts.push(plural(noteIds.length, 'note') + where);
    }
    if (pageIds.length > 0) parts.push(plural(pageIds.length, 'page'));
    if (elsewhere) parts.push('a deck or layout');
    return `Used by ${parts.join(', ')}`;
  };

  return (
    <div
      data-testid="check-panel"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Check collection</h2>
          <p className="text-xs text-[var(--muted)]">
            Find media files nothing uses or that are missing, and make sure the collection matches
            its history of changes.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void checkMediaNow()}
            className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            Check media
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void checkDatabaseNow()}
            className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            Check database
          </button>
        </div>
      </div>

      {busy && <p className="text-xs text-[var(--muted)]">Checking…</p>}
      {status && (
        <output className="block text-xs text-emerald-700 dark:text-emerald-300">{status}</output>
      )}
      {error && (
        <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}

      {report && (
        <section data-testid="media-check-result" className="flex flex-col gap-2 text-xs">
          <h3 className="text-sm font-semibold">Media</h3>
          <p>
            {plural(report.usedCount, 'file')} in use
            {report.spokenAudio > 0 ? `, ${plural(report.spokenAudio, 'spoken audio clip')}` : ''}.
            {report.unused.length === 0 &&
            report.missing.length === 0 &&
            report.unlisted.length === 0
              ? ' Nothing unused or missing.'
              : ''}
          </p>
          {!media.canListFiles && (
            <p className="text-[var(--muted)]">
              This device can't list its stored files, so only files in the collection were checked.
            </p>
          )}

          {report.missing.length > 0 && (
            <div data-testid="media-missing">
              <p className="font-medium">
                {plural(report.missing.length, 'file')} missing on this device
                {syncing && report.missing.some((m) => m.inCollection)
                  ? ' (sync may still download some of them)'
                  : ''}
              </p>
              <ul className="list-disc pl-5">
                {report.missing.slice(0, SHOWN).map((m) => (
                  <li key={m.hash}>
                    <span className="font-mono">{m.hash.slice(0, 10)}</span>:{' '}
                    {describeMissing(m.noteIds, m.pageIds, m.elsewhere)}
                  </li>
                ))}
              </ul>
              {report.missing.length > SHOWN && (
                <p className="text-[var(--muted)]">and {report.missing.length - SHOWN} more.</p>
              )}
              {syncing && report.missing.some((m) => m.inCollection) && (
                <button
                  type="button"
                  data-testid="media-fetch"
                  disabled={busy}
                  onClick={() => void fetchMissingNow()}
                  className="mt-1 self-start rounded-xl border border-[var(--border)] px-3 py-2 font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
                >
                  Sync now and check again
                </button>
              )}
            </div>
          )}

          {report.unlisted.length > 0 && (
            <div data-testid="media-unlisted">
              <p className="font-medium">
                {plural(report.unlisted.length, 'file')} in use but no longer in the collection
                (other devices won't get {report.unlisted.length === 1 ? 'it' : 'them'})
              </p>
              <ul className="list-disc pl-5">
                {report.unlisted.slice(0, SHOWN).map((m) => (
                  <li key={m.hash}>
                    <span className="font-mono">{m.hash.slice(0, 10)}</span>:{' '}
                    {describeMissing(m.noteIds, m.pageIds, m.elsewhere)}
                  </li>
                ))}
              </ul>
              {report.unlisted.length > SHOWN && (
                <p className="text-[var(--muted)]">and {report.unlisted.length - SHOWN} more.</p>
              )}
              <button
                type="button"
                data-testid="media-readd"
                disabled={busy}
                onClick={() => void reAddNow()}
                className="mt-1 self-start rounded-xl border border-[var(--border)] px-3 py-2 font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
              >
                Add back to the collection
              </button>
            </div>
          )}

          {report.unused.length > 0 && (
            <div data-testid="media-unused">
              <p className="font-medium">
                {plural(report.unused.length, 'unused file')}
                {report.unusedBytes > 0 ? ` (${formatBytes(report.unusedBytes)})` : ''}
              </p>
              <ul className="list-disc pl-5">
                {report.unused.slice(0, SHOWN).map((f) => (
                  <li key={f.hash}>
                    <span className="font-mono">{f.hash.slice(0, 10)}</span>
                    {f.mime ? ` ${f.mime}` : ''}
                    {f.size !== undefined ? `, ${formatBytes(f.size)}` : ''}
                    {f.inCollection ? '' : ', only on this device'}
                  </li>
                ))}
              </ul>
              {report.unused.length > SHOWN && (
                <p className="text-[var(--muted)]">and {report.unused.length - SHOWN} more.</p>
              )}
              {!confirmRemove ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmRemove(true)}
                  className="mt-1 rounded-xl border border-[var(--border)] px-3 py-2 font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
                >
                  Remove unused files…
                </button>
              ) : (
                <div
                  data-testid="media-remove-confirm"
                  className="mt-1 flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3"
                >
                  <p>
                    Remove {plural(removable, 'unused file')}?{' '}
                    {syncing ? 'They are taken out of the collection on every synced device. ' : ''}
                    {keptFiles > 0
                      ? `${plural(keptFiles, 'file')} a backup still holds stay on this device until that backup rolls off, so restoring it still works.`
                      : ''}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeNow()}
                      className="rounded-xl bg-[var(--accent)] px-3 py-2 font-semibold text-white disabled:opacity-50"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmRemove(false)}
                      className="rounded-xl border border-[var(--border)] px-3 py-2 font-semibold hover:bg-[var(--surface-2)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {report.keptForBackups > 0 && (
            <p className="text-[var(--muted)]">
              {plural(report.keptForBackups, 'file')} no longer in the collection stay on this
              device for the backups that hold them.
            </p>
          )}
        </section>
      )}

      {database && comparison && (
        <section data-testid="database-check-result" className="flex flex-col gap-2 text-xs">
          <h3 className="text-sm font-semibold">Database</h3>
          {comparison.total === 0 ? (
            <p>
              No problems found: the collection matches its history of{' '}
              {plural(comparison.rebuiltEvents, 'change')}.
            </p>
          ) : (
            <>
              <p className="font-medium">
                Found {plural(comparison.total, 'difference')} between the collection and its
                history of changes:
              </p>
              <ul className="list-disc pl-5">
                {(Object.entries(comparison.byArea) as [CollectionArea, number][]).map(
                  ([area, n]) => (
                    <li key={area}>
                      {AREA_LABELS[area]}: {n.toLocaleString()}
                    </li>
                  ),
                )}
              </ul>
              <details>
                <summary className="cursor-pointer">Details</summary>
                <ul className="pl-5 font-mono">
                  {comparison.differences.slice(0, 100).map((d) => (
                    <li key={`${d.area}:${d.id}`}>
                      {AREA_LABELS[d.area]} {d.id}: {KIND_LABELS[d.kind]}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          {database.changedDuringCheck && (
            <p className="text-[var(--muted)]">
              The collection changed while the check ran. Run it again when nothing is syncing.
            </p>
          )}
          {database.mode === 'snapshot' && (
            <p className="text-[var(--muted)]">
              Part of the history came to this device inside a snapshot from another device, so the
              check started from the saved snapshot.
            </p>
          )}
          {comparison.total > 0 && database.rebuilt && !database.changedDuringCheck && (
            <>
              {!confirmRebuild ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmRebuild(true)}
                  className="self-start rounded-xl border border-[var(--border)] px-3 py-2 font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
                >
                  Rebuild from history…
                </button>
              ) : (
                <div
                  data-testid="database-rebuild-confirm"
                  className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3"
                >
                  <p>
                    Rebuild the collection on this device from its history of changes? The app
                    reloads. The history itself is not changed, and other devices are not affected.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void rebuildNow()}
                      className="rounded-xl bg-[var(--accent)] px-3 py-2 font-semibold text-white disabled:opacity-50"
                    >
                      Rebuild and reload
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmRebuild(false)}
                      className="rounded-xl border border-[var(--border)] px-3 py-2 font-semibold hover:bg-[var(--surface-2)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
