import type {
  InstalledPackInfo,
  PackCatalog,
  PackCatalogEntry,
  PackId,
  PackInstallProgress,
} from '@flash/platform';
import { isPackForActiveLanguages } from '@flash/core';
import { MAX_PACK_PICK_BYTES } from './packPickLimit.ts';
import { tooLargeMessage } from '../components/pickedFileLimit.ts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { useActiveLanguages } from '../state/useActiveLanguages.ts';
import { ShowAllLanguagesSwitch, useShowAllLanguages } from './ShowAllLanguagesSwitch.tsx';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatProgressLabel(progress: PackInstallProgress | null): string {
  if (!progress) return '';
  if (progress.phase === 'downloading') {
    if (progress.totalBytes && progress.totalBytes > 0) {
      const pct = Math.min(
        100,
        Math.round(((progress.loadedBytes ?? 0) / progress.totalBytes) * 100),
      );
      return `Downloading ${pct}%…`;
    }
    return `Downloading (${formatBytes(progress.loadedBytes ?? 0)})…`;
  }
  if (progress.phase === 'verifying') return 'Verifying SHA-256 & schema…';
  if (progress.phase === 'indexing') {
    return `Indexing ${progress.indexedEntries ?? 0}/${progress.totalEntries ?? '?'}…`;
  }
  return 'Done';
}

export interface PackManagerPanelProps {
  onInstalledPacksChanged?: (packs: InstalledPackInfo[]) => void;
}

/**
 * Downloadable offline dictionary & stroke pack manager (§6.3, §6.4, ADR 0001 Spike 0.6).
 * Strictly lazy-loaded inside SettingsScreen so initial study-screen JS pays 0 KB.
 */
export function PackManagerPanel({ onInstalledPacksChanged }: PackManagerPanelProps) {
  const { platform } = useApp();

  const [catalog, setCatalog] = useState<PackCatalog | null>(null);
  const [installed, setInstalled] = useState<InstalledPackInfo[]>([]);
  const [catalogUrlDraft, setCatalogUrlDraft] = useState('');
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [busyPackId, setBusyPackId] = useState<string | null>(null);
  const [progress, setProgress] = useState<PackInstallProgress | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every state update waits for the pack manager to load, so the mount effect sets none itself.
  const refreshState = useCallback(
    (fetchRemoteCatalog = true): Promise<void> => {
      if (!platform.getPackManager) return Promise.resolve();
      return platform.getPackManager().then(async (mgr) => {
        const currentUrl = mgr.getCatalogUrl() ?? '';
        setCatalogUrlDraft(currentUrl);
        const list = await mgr.listInstalledPacks();
        setInstalled(list);
        onInstalledPacksChanged?.(list);

        if (fetchRemoteCatalog && currentUrl) {
          setLoadingCatalog(true);
          try {
            const cat = await mgr.fetchCatalog(currentUrl);
            setCatalog(cat);
            setError(null);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setLoadingCatalog(false);
          }
        }
      });
    },
    [onInstalledPacksChanged, platform],
  );

  useEffect(() => {
    void refreshState(true);
  }, [refreshState]);

  const installedById = new Map(installed.map((p) => [p.id, p]));
  const totalBytes = installed.reduce((sum, p) => sum + p.byteSize, 0);

  // UX #2: only packs for the languages in use, unless "Show all languages" is on (this device).
  const { languages, known } = useActiveLanguages();
  const [showAllLanguages, setShowAllLanguages] = useShowAllLanguages();
  const shown = (pack: { kind: string; language: string; script?: string | undefined }) =>
    showAllLanguages || isPackForActiveLanguages(languages, pack, known);
  const catalogPacks = catalog ? catalog.packs.filter(shown) : [];
  const installedPacks = installed.filter(shown);
  // Hidden by language: catalog rows, plus installed packs the catalog does not list.
  const catalogIds = new Set(catalog?.packs.map((p) => p.id));
  const hiddenInstalledOffCatalog = installed.filter(
    (p) => !catalogIds.has(p.id) && !shown(p),
  ).length;
  const hiddenCount = catalog
    ? catalog.packs.length - catalogPacks.length + hiddenInstalledOffCatalog
    : installed.length - installedPacks.length;

  const handleSaveCatalogUrl = async (e: FormEvent) => {
    e.preventDefault();
    if (!platform.getPackManager) return;
    setError(null);
    setStatus(null);
    try {
      const mgr = await platform.getPackManager();
      await mgr.setCustomCatalogUrl(catalogUrlDraft.trim() || undefined);
      await refreshState(true);
      setStatus('Pack catalog URL updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleInstallCatalogPack = async (entry: PackCatalogEntry) => {
    if (!platform.getPackManager) return;
    setBusyPackId(entry.id);
    setProgress({ phase: 'downloading', loadedBytes: 0 });
    setError(null);
    setStatus(null);
    try {
      const mgr = await platform.getPackManager();
      const info = await mgr.installPackFromCatalog(entry, (p) => setProgress(p));
      await refreshState(false);
      setStatus(
        `Installed ${info.name} (${info.entryCount.toLocaleString()} entries, offline ready).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A failed reinstall leaves the pack not installed (D15): show that, not the old row.
      void refreshState(false).catch(() => {});
    } finally {
      setBusyPackId(null);
      setProgress(null);
    }
  };

  const handleDownloadAllShards = async (packId: PackId, name: string) => {
    if (!platform.getPackManager) return;
    setBusyPackId(packId);
    setProgress({ phase: 'downloading', loadedBytes: 0 });
    setError(null);
    setStatus(null);
    try {
      const mgr = await platform.getPackManager();
      if (!mgr.downloadAllShards) return;
      await mgr.downloadAllShards(packId, (p) => setProgress(p));
      await refreshState(false);
      setStatus(`${name} is fully on this device.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPackId(null);
      setProgress(null);
    }
  };

  const handleRemovePack = async (packId: PackId, name: string) => {
    if (!platform.getPackManager) return;
    setBusyPackId(packId);
    setError(null);
    setStatus(null);
    try {
      const mgr = await platform.getPackManager();
      await mgr.removePack(packId);
      await refreshState(false);
      setStatus(`Removed ${name} from local storage.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPackId(null);
    }
  };

  const handleImportLocalPack = async () => {
    if (!platform.getPackManager) return;
    setError(null);
    setStatus(null);
    try {
      const picked = await platform.files.pickFile({
        accept: '.gz,.json',
        maxBytes: MAX_PACK_PICK_BYTES,
      });
      if (!picked) return;
      const tooLarge = tooLargeMessage(picked, MAX_PACK_PICK_BYTES, 'for a dictionary pack');
      if (tooLarge) {
        setError(tooLarge);
        return;
      }
      setBusyPackId('local-import');
      setProgress({ phase: 'verifying' });
      const mgr = await platform.getPackManager();
      const info = await mgr.installPackFromBytes(picked.bytes, {
        onProgress: (p) => setProgress(p),
      });
      await refreshState(false);
      setStatus(
        `Imported local pack "${info.name}" (${info.entryCount.toLocaleString()} entries).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void refreshState(false).catch(() => {});
    } finally {
      setBusyPackId(null);
      setProgress(null);
    }
  };

  return (
    <div
      data-testid="pack-manager-card"
      className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Offline Dictionaries &amp; Stroke Packs</h2>
          <p className="text-xs text-[var(--muted)]">
            Downloaded once and cached locally in IndexedDB. Japanese (KanjiVG) and Chinese/Hanja
            (Make Me a Hanzi) stroke data stay separate with full upstream license attribution.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--muted)]">
            {installed.length} installed · {formatBytes(totalBytes)}
          </span>
          <button
            type="button"
            data-testid="import-local-pack-btn"
            disabled={busyPackId !== null}
            onClick={() => void handleImportLocalPack()}
            className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-40"
          >
            Import Local Pack
          </button>
        </div>
      </div>

      {status && (
        <div
          role="status"
          data-testid="pack-manager-status"
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
        >
          {status}
        </div>
      )}
      {error && (
        <div
          role="alert"
          data-testid="pack-manager-error"
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
        >
          {error}
        </div>
      )}

      {/* Unified Static Pack Catalog URL (packs.json) */}
      <form
        onSubmit={(e) => void handleSaveCatalogUrl(e)}
        className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 sm:flex-row sm:items-center"
      >
        <label htmlFor="pack-catalog-url-input" className="text-xs font-medium text-[var(--muted)]">
          Pack Catalog (<code>packs.json</code>)
        </label>
        <input
          id="pack-catalog-url-input"
          type="text"
          data-testid="pack-catalog-url-input"
          placeholder="https://your-packs-host.pages.dev/packs.json"
          value={catalogUrlDraft}
          onChange={(e) => setCatalogUrlDraft(e.target.value)}
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--fg)]"
        />
        <button
          type="submit"
          disabled={loadingCatalog || busyPackId !== null}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-40"
        >
          {loadingCatalog ? 'Loading…' : 'Load Catalog'}
        </button>
      </form>

      {(catalog || installed.length > 0) && (
        <ShowAllLanguagesSwitch
          testId="pack-show-all-languages"
          checked={showAllLanguages}
          onChange={setShowAllLanguages}
          hiddenCount={hiddenCount}
        />
      )}

      {/* Catalog Pack List */}
      {catalog ? (
        <div className="flex flex-col gap-2">
          {catalogPacks.map((entry) => {
            const local = installedById.get(entry.id);
            const hasUpdate = Boolean(local && local.version !== entry.version);
            const isBusy = busyPackId === entry.id;

            return (
              <div
                key={entry.id}
                data-testid={`pack-row-${entry.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--muted)]">
                      {entry.kind === 'dictionary' ? 'Dict' : 'Strokes'} · {entry.language}
                    </span>
                    <span className="text-xs font-semibold text-[var(--fg)]">{entry.name}</span>
                    {entry.optional && (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                        Optional
                      </span>
                    )}
                    {local && (
                      <span
                        data-testid={`pack-installed-badge-${entry.id}`}
                        className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300"
                      >
                        Installed (v{local.version})
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-[var(--muted)]">{entry.description}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted)]">
                    <span>{entry.entry_count.toLocaleString()} entries</span>
                    <span>{formatBytes(entry.compressed_bytes)} download</span>
                    {entry.shards && (
                      <span data-testid={`pack-shards-${entry.id}`}>
                        + up to {formatBytes(entry.shards.compressed_bytes)} in {entry.shards.count}{' '}
                        parts as you look words up
                        {local?.shardCount !== undefined &&
                          ` (${local.shardsLoaded ?? 0} of ${local.shardCount} on this device)`}
                      </span>
                    )}
                    <span>License: {entry.license_name}</span>
                  </div>
                  {isBusy && progress && (
                    <div className="mt-1 text-[11px] font-medium text-[var(--accent)]">
                      {formatProgressLabel(progress)}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {(!local || hasUpdate) && (
                    <button
                      type="button"
                      data-testid={`pack-install-btn-${entry.id}`}
                      disabled={busyPackId !== null}
                      onClick={() => void handleInstallCatalogPack(entry)}
                      className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
                    >
                      {isBusy ? 'Installing…' : hasUpdate ? 'Update' : 'Install'}
                    </button>
                  )}
                  {local?.shardCount !== undefined &&
                    (local.shardsLoaded ?? 0) < local.shardCount &&
                    !hasUpdate && (
                      <button
                        type="button"
                        data-testid={`pack-download-all-btn-${entry.id}`}
                        disabled={busyPackId !== null}
                        onClick={() => void handleDownloadAllShards(entry.id, entry.name)}
                        className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--surface)] disabled:opacity-40"
                      >
                        Download all for offline
                      </button>
                    )}
                  {local && (
                    <button
                      type="button"
                      data-testid={`pack-remove-btn-${entry.id}`}
                      disabled={busyPackId !== null}
                      onClick={() => void handleRemovePack(entry.id, entry.name)}
                      className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-500/20 disabled:opacity-40 dark:text-rose-400"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : installed.length > 0 ? (
        <div className="flex flex-col gap-2">
          {installedPacks.map((local) => (
            <div
              key={local.id}
              data-testid={`pack-row-${local.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
            >
              <div>
                <div className="text-xs font-semibold">{local.name}</div>
                <div className="text-[11px] text-[var(--muted)]">
                  v{local.version} · {local.entryCount.toLocaleString()} entries ·{' '}
                  {formatBytes(local.byteSize)} · {local.licenseName}
                </div>
              </div>
              <button
                type="button"
                data-testid={`pack-remove-btn-${local.id}`}
                disabled={busyPackId !== null}
                onClick={() => void handleRemovePack(local.id, local.name)}
                className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--muted)]">
          Configure <code>VITE_PACK_CATALOG_URL</code> (pointing to a static <code>packs.json</code>{' '}
          manifest) or use <strong>Import Local Pack</strong> to install offline dictionaries and
          stroke data.
        </p>
      )}
    </div>
  );
}
