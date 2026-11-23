import { compareCodeUnits } from '@flash/core';
import { canCreateOrImportDeck } from '@flash/core/license';
import type {
  CatalogPackageInfo,
  LinkedGoogleSource,
  LinkedLocalFolder,
  LinkedOneDriveSource,
  PackageSubscription,
  PendingXlsxReconciliation,
  SourcesRegistry,
  SourceSyncStatus,
  SourceWarning,
} from '@flash/platform';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../state/AppContext.tsx';

const LazyOneDrivePickerPanel = lazy(() => import('../sources/OneDrivePickerPanel.tsx'));

function formatStatusLabel(status?: SourceSyncStatus): string {
  switch (status) {
    case 'synced':
      return 'Synced';
    case 'permission_required':
      return 'Permission needed';
    case 'offline':
      return 'Offline';
    case 'error':
      return 'Error';
    default:
      return 'Ready';
  }
}

function getStatusPillClass(status?: SourceSyncStatus): string {
  switch (status) {
    case 'synced':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'permission_required':
    case 'offline':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'error':
      return 'bg-rose-500/15 text-rose-700 dark:text-rose-300';
    default:
      return 'bg-[var(--surface-2)] text-[var(--muted)]';
  }
}

function isSafeExternalGoogleUrl(uri?: string): boolean {
  return Boolean(
    uri &&
    (uri.startsWith('https://docs.google.com/spreadsheets/') ||
      uri.startsWith('https://docs.google.com/document/')),
  );
}

function WarningsDisclosure({ warnings }: { warnings?: SourceWarning[] | undefined }) {
  const [open, setOpen] = useState(false);
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs font-medium text-amber-700 hover:underline dark:text-amber-300"
      >
        {open ? 'Hide' : 'Show'} {warnings.length} import warning(s)
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
          {warnings.map((w, idx) => (
            <li key={`${w.code}-${idx}`}>
              {w.file ? <span className="font-mono font-semibold">[{w.file}] </span> : null}
              {w.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface SourcesPanelProps {
  onStatusMessage: (msg: string) => void;
  onErrorMessage: (msg: string | null) => void;
}

export function SourcesPanel({ onStatusMessage, onErrorMessage }: SourcesPanelProps) {
  const { platform, state, stateVersion, entitlement, emitEvents, getEventFactory } = useApp();

  const activeDeckCount = useMemo(
    () => [...state.decks.values()].filter((d) => !d.archived).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const [registry, setRegistry] = useState<SourcesRegistry>({
    googleSources: [],
    oneDriveSources: [],
    localFolders: [],
    packageSubscriptions: [],
    catalogs: [],
  });
  const [googleConnected, setGoogleConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [templateTitle, setTemplateTitle] = useState('');
  const [templateNoteTypeId, setTemplateNoteTypeId] = useState('preset:vocab-ko');
  const [templateLang, setTemplateLang] = useState('ko');

  const [showSubscribeForm, setShowSubscribeForm] = useState(false);
  const [showOneDrivePicker, setShowOneDrivePicker] = useState(false);
  const [subscribeUrl, setSubscribeUrl] = useState('');
  const [subscribeKind, setSubscribeKind] = useState<'auto' | 'package' | 'catalog'>('auto');

  const [pendingReconciliations, setPendingReconciliations] = useState<PendingXlsxReconciliation[]>(
    [],
  );
  const [reconcileChoices, setReconcileChoices] = useState<Record<string, Record<string, string>>>(
    {},
  );

  // Built-in Starter Decks catalog (VITE_STARTER_CATALOG_URL -> FamilyCatalog index.json, §3.4)
  const [starterCatalog, setStarterCatalog] = useState<{
    name: string;
    description?: string;
    packages: CatalogPackageInfo[];
  } | null>(null);
  const [starterCatalogLoading, setStarterCatalogLoading] = useState(false);
  const [starterCatalogError, setStarterCatalogError] = useState<string | null>(null);

  useEffect(() => {
    const starterUrl = platform.starterCatalogUrl?.trim();
    if (!starterUrl) return undefined;
    let cancelled = false;
    setStarterCatalogLoading(true);
    setStarterCatalogError(null);

    void (async () => {
      const cacheKey = `starter_catalog_cache_v1:${starterUrl}`;
      const cached = await platform.storage.getKv<{
        etag?: string;
        name: string;
        description?: string;
        packages: CatalogPackageInfo[];
      }>(cacheKey);
      if (cached && !cancelled) {
        setStarterCatalog({
          name: cached.name,
          ...(cached.description ? { description: cached.description } : {}),
          packages: cached.packages,
        });
      }
      try {
        const [fetcher, { parseAndValidateFamilyCatalog }] = await Promise.all([
          platform.getPackageFetcher(),
          import('@flash/core/sources'),
        ]);
        const res = await fetcher.fetchCatalog(
          starterUrl,
          cached?.etag ? { etag: cached.etag } : undefined,
        );
        if (!res.notModified) {
          const parsed = parseAndValidateFamilyCatalog(res.rawJson);
          const nextCatalog = {
            name: parsed.name,
            ...(parsed.description ? { description: parsed.description } : {}),
            packages: parsed.packages as CatalogPackageInfo[],
          };
          await platform.storage.setKv(cacheKey, {
            ...nextCatalog,
            ...(res.etag ? { etag: res.etag } : {}),
          });
          if (!cancelled) {
            setStarterCatalog(nextCatalog);
          }
        }
      } catch (err) {
        if (!cancelled && !cached) {
          setStarterCatalogError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setStarterCatalogLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [platform]);

  const noteTypes = useMemo(
    () => [...state.noteTypes.values()],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const importedPages = useMemo(
    () =>
      [...state.pages.values()].sort(
        (a, b) => compareCodeUnits(a.title, b.title) || compareCodeUnits(a.id, b.id),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const makeRunnerCtx = useCallback(
    () => ({
      platform,
      getState: () => state,
      getEventFactory,
      emitEvents,
    }),
    [emitEvents, getEventFactory, platform, state],
  );

  // Load persisted source registry & check Google auth state on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ loadSourcesRegistry }, authConnected] = await Promise.all([
        import('../sources/sourceRunner.ts'),
        platform.googleOAuthConfigured
          ? platform
              .getGoogleAuth()
              .then((a) => a.isConnected())
              .catch(() => false)
          : Promise.resolve(false),
      ]);
      const loaded = await loadSourcesRegistry(platform, state);
      if (!cancelled) {
        setRegistry(loaded);
        setGoogleConnected(authConnected);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, stateVersion]);

  const totalSources =
    registry.googleSources.length +
    (registry.oneDriveSources?.length ?? 0) +
    registry.localFolders.length +
    registry.packageSubscriptions.length +
    registry.catalogs.length;

  const handleSignInGoogleForSources = async () => {
    onErrorMessage(null);
    try {
      const auth = await platform.getGoogleAuth();
      await auth.signIn({ intent: 'sources' });
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleLinkGooglePicker = async () => {
    const gate = canCreateOrImportDeck(activeDeckCount, entitlement);
    if (!gate.allowed) {
      onErrorMessage(gate.reason ?? 'Free tier deck limit reached.');
      return;
    }
    setBusy(true);
    onErrorMessage(null);
    try {
      const picker = await platform.getGooglePicker();
      const picked = await picker.pickSheetsAndDocs();
      if (picked.length === 0) return;

      const { linkPickedGoogleFiles } = await import('../sources/sourceRunner.ts');
      const summary = await linkPickedGoogleFiles(picked, makeRunnerCtx());
      setRegistry(summary.registry);
      if (summary.errors.length > 0) {
        onErrorMessage(summary.errors.join(' | '));
      } else {
        const warnSuffix =
          summary.warningsCount > 0 ? ` (${summary.warningsCount} warning(s))` : '';
        onStatusMessage(
          `Linked ${picked.length} Google file(s): ${summary.importedNotes} note(s), ${summary.importedPages} page(s)${warnSuffix}.`,
        );
      }
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateTemplate = async (e: FormEvent) => {
    e.preventDefault();
    if (!templateTitle.trim()) return;
    const gate = canCreateOrImportDeck(activeDeckCount, entitlement);
    if (!gate.allowed) {
      onErrorMessage(gate.reason ?? 'Free tier deck limit reached.');
      return;
    }
    setBusy(true);
    onErrorMessage(null);
    try {
      const { createAndLinkGoogleSheetTemplate } = await import('../sources/sourceRunner.ts');
      const res = await createAndLinkGoogleSheetTemplate(
        {
          title: templateTitle.trim(),
          noteTypeId: templateNoteTypeId,
          language: templateLang,
        },
        makeRunnerCtx(),
      );
      setRegistry(res.registry);
      setTemplateTitle('');
      setShowTemplateForm(false);
      onStatusMessage(`Created and linked Google Sheet "${res.source.name}".`);
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLinkLocalFolder = async () => {
    const gate = canCreateOrImportDeck(activeDeckCount, entitlement);
    if (!gate.allowed) {
      onErrorMessage(gate.reason ?? 'Free tier deck limit reached.');
      return;
    }
    setBusy(true);
    onErrorMessage(null);
    try {
      const { linkAndScanLocalFolder } = await import('../sources/sourceRunner.ts');
      const res = await linkAndScanLocalFolder(makeRunnerCtx());
      if (!res.folder || !res.summary) return;
      setRegistry(res.summary.registry);
      if (res.summary.pendingReconciliations.length > 0) {
        setPendingReconciliations(res.summary.pendingReconciliations);
      }
      if (res.summary.errors.length > 0) {
        onErrorMessage(res.summary.errors.join(' | '));
      } else {
        const inboxSuffix =
          res.summary.inboxImported > 0 ? `, ${res.summary.inboxImported} Inbox package(s)` : '';
        onStatusMessage(
          `Linked folder "${res.folder.name}": ${res.summary.importedNotes} note(s), ${res.summary.importedPages} page(s)${inboxSuffix}.`,
        );
      }
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSubscribeUrl = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = subscribeUrl.trim();
    if (!trimmed) return;
    setBusy(true);
    onErrorMessage(null);
    try {
      const treatAsCatalog =
        subscribeKind === 'catalog' ||
        (subscribeKind === 'auto' && /\.json(?:[?#].*)?$/i.test(trimmed));

      if (treatAsCatalog) {
        const { subscribeToFamilyCatalog } = await import('../sources/sourceRunner.ts');
        const res = await subscribeToFamilyCatalog(trimmed, makeRunnerCtx());
        setRegistry(res.registry);
        onStatusMessage(
          `Added Family Library "${res.catalog.name}" (${res.catalog.packages.length} package(s)).`,
        );
      } else {
        const gate = canCreateOrImportDeck(activeDeckCount, entitlement);
        if (!gate.allowed) {
          onErrorMessage(gate.reason ?? 'Free tier deck limit reached.');
          return;
        }
        const { subscribeToPackageUrl } = await import('../sources/sourceRunner.ts');
        const res = await subscribeToPackageUrl(trimmed, makeRunnerCtx());
        setRegistry(res.registry);
        onStatusMessage(
          `Subscribed to "${res.subscription.title}"${res.subscription.version ? ` (v${res.subscription.version})` : ''}.`,
        );
      }
      setSubscribeUrl('');
      setShowSubscribeForm(false);
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSubscribeCatalogEntry = async (catalogUrl: string, pkg: CatalogPackageInfo) => {
    const isExistingSub = registry.packageSubscriptions.some(
      (s) => s.url === pkg.url || s.packageId === pkg.package_id,
    );
    if (!isExistingSub) {
      const gate = canCreateOrImportDeck(activeDeckCount, entitlement);
      if (!gate.allowed) {
        onErrorMessage(gate.reason ?? 'Free tier deck limit reached.');
        return;
      }
    }
    setBusy(true);
    onErrorMessage(null);
    try {
      const { subscribeToPackageUrl } = await import('../sources/sourceRunner.ts');
      const res = await subscribeToPackageUrl(pkg.url, makeRunnerCtx(), {
        title: pkg.title,
        packageId: pkg.package_id,
        catalogUrl,
        ...(pkg.sha256 !== undefined ? { expectedSha256: pkg.sha256 } : {}),
      });
      setRegistry(res.registry);
      onStatusMessage(`Subscribed to "${res.subscription.title}" (v${pkg.version}).`);
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshAll = async () => {
    setBusy(true);
    onErrorMessage(null);
    try {
      const { refreshAllSources } = await import('../sources/sourceRunner.ts');
      const summary = await refreshAllSources(makeRunnerCtx(), { requestFolderPermission: true });
      setRegistry(summary.registry);
      if (summary.pendingReconciliations.length > 0) {
        setPendingReconciliations(summary.pendingReconciliations);
      }
      if (summary.errors.length > 0) {
        onErrorMessage(summary.errors.join(' | '));
      } else {
        const parts: string[] = [];
        if (summary.importedNotes > 0) parts.push(`${summary.importedNotes} note change(s)`);
        if (summary.importedPages > 0) parts.push(`${summary.importedPages} page(s)`);
        if (summary.inboxImported > 0) parts.push(`${summary.inboxImported} Inbox package(s)`);
        onStatusMessage(
          parts.length > 0
            ? `Refreshed sources: ${parts.join(', ')}.`
            : 'All linked sources are up to date.',
        );
      }
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshGoogleOne = async (src: LinkedGoogleSource) => {
    setBusy(true);
    onErrorMessage(null);
    try {
      const { loadSourcesRegistry, refreshSingleGoogleSource, saveSourcesRegistry } =
        await import('../sources/sourceRunner.ts');
      const nextReg = await loadSourcesRegistry(platform, state);
      const target = nextReg.googleSources.find((s) => s.id === src.id);
      if (!target) return;
      const res = await refreshSingleGoogleSource(target, makeRunnerCtx(), { force: true });
      await saveSourcesRegistry(platform, nextReg);
      setRegistry(nextReg);
      onStatusMessage(
        res.updated
          ? `Refreshed "${target.name}" (${res.notesTouched} note change(s), ${res.pagesTouched} page(s)).`
          : `"${target.name}" is already up to date.`,
      );
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAllowOneDriveAccess = async () => {
    onErrorMessage(null);
    try {
      const picker = await platform.getOneDrivePicker?.();
      // Web redirects to Microsoft sign-in; native shells return once the user consents.
      if (picker && (await picker.requestFileAccess())) {
        onStatusMessage('OneDrive file access allowed. Refresh the source to pull it.');
      }
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRefreshOneDriveOne = async (src: LinkedOneDriveSource) => {
    setBusy(true);
    onErrorMessage(null);
    try {
      const { loadSourcesRegistry, refreshSingleOneDriveSource, saveSourcesRegistry } =
        await import('../sources/sourceRunner.ts');
      const nextReg = await loadSourcesRegistry(platform, state);
      const target = nextReg.oneDriveSources?.find((s) => s.id === src.id);
      if (!target) return;
      try {
        const res = await refreshSingleOneDriveSource(target, makeRunnerCtx(), { force: true });
        if (res.pending) {
          const held = res.pending;
          setPendingReconciliations((prev) => [
            ...prev.filter(
              (r) => !(r.folderId === held.folderId && r.relativePath === held.relativePath),
            ),
            held,
          ]);
          onStatusMessage(
            `"${target.name}" has rows that may be renamed. Match them below to keep review history.`,
          );
        } else if (target.lastStatus === 'permission_required') {
          onErrorMessage(target.lastError ?? 'Allow OneDrive file access to refresh this source.');
        } else if (target.lastError) {
          onErrorMessage(target.lastError);
        } else if (target.lastStatus === 'offline') {
          onErrorMessage('You are offline. Try again when you are back online.');
        } else {
          onStatusMessage(
            res.updated
              ? `Refreshed "${target.name}" (${res.notesTouched} note change(s)).`
              : `"${target.name}" is already up to date.`,
          );
        }
      } catch (err) {
        target.lastStatus = 'error';
        target.lastError = err instanceof Error ? err.message : String(err);
        onErrorMessage(target.lastError);
      }
      await saveSourcesRegistry(platform, nextReg);
      setRegistry(nextReg);
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshFolderOne = async (folder: LinkedLocalFolder) => {
    setBusy(true);
    onErrorMessage(null);
    try {
      const { loadSourcesRegistry, saveSourcesRegistry, scanSingleLocalFolder } =
        await import('../sources/sourceRunner.ts');
      const nextReg = await loadSourcesRegistry(platform, state);
      const target = nextReg.localFolders.find((f) => f.id === folder.id);
      if (!target) return;
      const res = await scanSingleLocalFolder(target, makeRunnerCtx(), {
        requestPermission: true,
      });
      await saveSourcesRegistry(platform, nextReg);
      setRegistry(nextReg);
      if (res.pendingReconciliations.length > 0) {
        setPendingReconciliations(res.pendingReconciliations);
      }
      if (res.error) {
        onErrorMessage(res.error);
      } else {
        onStatusMessage(
          res.updated
            ? `Scanned "${target.name}" (${res.notesTouched} note change(s), ${res.pagesTouched} page(s), ${res.inboxImported} Inbox).`
            : `"${target.name}" has no new changes.`,
        );
      }
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleFolderWriteCardIds = async (folder: LinkedLocalFolder, enabled: boolean) => {
    const { loadSourcesRegistry, saveSourcesRegistry } = await import('../sources/sourceRunner.ts');
    const nextReg = await loadSourcesRegistry(platform, state);
    const target = nextReg.localFolders.find((f) => f.id === folder.id);
    if (!target) return;
    target.writeCardIds = enabled;
    await saveSourcesRegistry(platform, nextReg);
    setRegistry(nextReg);
  };

  const handleRefreshPackageOne = async (sub: PackageSubscription) => {
    setBusy(true);
    onErrorMessage(null);
    try {
      const { loadSourcesRegistry, refreshSinglePackageSubscription, saveSourcesRegistry } =
        await import('../sources/sourceRunner.ts');
      const nextReg = await loadSourcesRegistry(platform, state);
      const target = nextReg.packageSubscriptions.find((p) => p.id === sub.id);
      if (!target) return;
      const res = await refreshSinglePackageSubscription(target, makeRunnerCtx(), { force: true });
      await saveSourcesRegistry(platform, nextReg);
      setRegistry(nextReg);
      onStatusMessage(
        res.updated
          ? `Updated "${target.title}"${target.version ? ` to v${target.version}` : ''}.`
          : `"${target.title}" is already up to date.`,
      );
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async (
    kind: 'google' | 'onedrive' | 'folder' | 'package' | 'catalog',
    id: string,
  ) => {
    const { loadSourcesRegistry, saveSourcesRegistry } = await import('../sources/sourceRunner.ts');
    const nextReg = await loadSourcesRegistry(platform, state);
    if (kind === 'google') {
      nextReg.googleSources = nextReg.googleSources.filter((s) => s.id !== id);
    } else if (kind === 'onedrive') {
      const removed = (nextReg.oneDriveSources ?? []).find((s) => s.id === id);
      nextReg.oneDriveSources = (nextReg.oneDriveSources ?? []).filter((s) => s.id !== id);
      // The deck keeps its source, so remember the unlink or the row comes back from the deck.
      if (removed) {
        nextReg.unlinkedOneDriveIds = [
          ...new Set([...(nextReg.unlinkedOneDriveIds ?? []), removed.itemId]),
        ];
      }
    } else if (kind === 'folder') {
      nextReg.localFolders = nextReg.localFolders.filter((f) => f.id !== id);
      const adapter = await platform.getLocalFolderSources();
      await adapter.removeFolder(id);
    } else if (kind === 'package') {
      nextReg.packageSubscriptions = nextReg.packageSubscriptions.filter((p) => p.id !== id);
    } else {
      nextReg.catalogs = nextReg.catalogs.filter((c) => c.id !== id);
    }
    await saveSourcesRegistry(platform, nextReg);
    setRegistry(nextReg);
    onStatusMessage('Source unlinked. Local decks and review history remain intact.');
  };

  const handleApplyReconciliation = async (rec: PendingXlsxReconciliation) => {
    setBusy(true);
    onErrorMessage(null);
    try {
      const key = `${rec.folderId}:${rec.relativePath}`;
      const chosen = reconcileChoices[key] ?? {};
      const renameMap: Record<string, string> = {};
      for (const [noteId, newSortKey] of Object.entries(chosen)) {
        if (newSortKey) renameMap[noteId] = newSortKey;
      }

      const {
        loadSourcesRegistry,
        ONEDRIVE_RECONCILE_PREFIX,
        refreshSingleOneDriveSource,
        saveSourcesRegistry,
        scanSingleLocalFolder,
      } = await import('../sources/sourceRunner.ts');
      const nextReg = await loadSourcesRegistry(platform, state);
      if (rec.folderId.startsWith(ONEDRIVE_RECONCILE_PREFIX)) {
        const itemId = rec.folderId.slice(ONEDRIVE_RECONCILE_PREFIX.length);
        const od = nextReg.oneDriveSources?.find((s) => s.itemId === itemId);
        if (!od) return;
        const res = await refreshSingleOneDriveSource(od, makeRunnerCtx(), {
          force: true,
          renameMap,
        });
        await saveSourcesRegistry(platform, nextReg);
        setRegistry(nextReg);
        if (
          od.lastStatus === 'offline' ||
          od.lastStatus === 'permission_required' ||
          res.unreadable
        ) {
          // Nothing was applied: keep the prompt so the user can answer it again later.
          onErrorMessage(
            od.lastStatus === 'offline'
              ? 'You are offline. Try again when you are back online.'
              : (od.lastError ?? 'OneDrive could not be read. Try Refresh on the source.'),
          );
          return;
        }
        setPendingReconciliations((prev) =>
          prev.filter((r) => !(r.folderId === rec.folderId && r.relativePath === rec.relativePath)),
        );
        onStatusMessage(
          res.updated
            ? `Applied the OneDrive changes to "${rec.deckName}".`
            : `"${rec.deckName}" is already up to date.`,
        );
        return;
      }
      const folder = nextReg.localFolders.find((f) => f.id === rec.folderId);
      if (!folder) return;

      await scanSingleLocalFolder(folder, makeRunnerCtx(), {
        requestPermission: true,
        force: true,
        xlsxRenameMaps: { [rec.relativePath]: renameMap },
      });
      await saveSourcesRegistry(platform, nextReg);
      setRegistry(nextReg);
      setPendingReconciliations((prev) =>
        prev.filter((r) => !(r.folderId === rec.folderId && r.relativePath === rec.relativePath)),
      );
      onStatusMessage(`Applied .xlsx reconciliation for "${rec.deckName}".`);
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="sources-panel"
      className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Linked Sources & Subscriptions</h2>
          <p className="text-xs text-[var(--muted)]">
            Pull updates from Google Sheets/Docs, OneDrive spreadsheets, PC local folders (including{' '}
            <code>Inbox/</code>), or subscribed <code>.flashpkg</code> URLs. Everything stays cached
            offline.
          </p>
        </div>

        <button
          type="button"
          data-testid="refresh-sources-btn"
          disabled={busy || totalSources === 0}
          onClick={() => void handleRefreshAll()}
          className="rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Refreshing…' : 'Refresh Sources'}
        </button>
      </div>

      {/* Built-in 1-tap Starter Decks Catalog (VITE_STARTER_CATALOG_URL -> FamilyCatalog index.json, §3.4) */}
      {platform.starterCatalogUrl && (
        <div
          data-testid="starter-decks-section"
          className="flex flex-col gap-2 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)]/40 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
                  Starter Decks
                </span>
                <span className="text-xs font-semibold text-[var(--fg)]">
                  {starterCatalog?.name ?? 'Curated Starter Decks'}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                {starterCatalog?.description ??
                  'Install vetted starter decks in one tap—no Google Drive or account needed.'}
              </p>
            </div>
            {starterCatalogLoading && (
              <span className="text-[11px] text-[var(--muted)]">Checking catalog…</span>
            )}
          </div>

          {starterCatalogError && (
            <div className="text-[11px] text-rose-600 dark:text-rose-400">
              Could not load starter catalog: {starterCatalogError}
            </div>
          )}

          {starterCatalog && starterCatalog.packages.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {starterCatalog.packages.map((pkg) => {
                const sub = registry.packageSubscriptions.find(
                  (s) => s.url === pkg.url || s.packageId === pkg.package_id,
                );
                return (
                  <div
                    key={pkg.package_id}
                    data-testid={`starter-pkg-${pkg.package_id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-semibold">{pkg.title}</span>
                        <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
                          v{pkg.version}
                        </span>
                        {pkg.languages.map((lang) => (
                          <span
                            key={lang}
                            className="rounded bg-[var(--surface-2)] px-1 py-0.5 text-[10px] text-[var(--muted)]"
                          >
                            {lang}
                          </span>
                        ))}
                      </div>
                      {pkg.description && (
                        <div className="text-[11px] text-[var(--muted)]">{pkg.description}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      data-testid={`starter-install-${pkg.package_id}`}
                      disabled={busy}
                      onClick={() =>
                        void handleSubscribeCatalogEntry(platform.starterCatalogUrl ?? '', pkg)
                      }
                      className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                        sub
                          ? 'border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-2)]'
                          : 'bg-[var(--accent)] text-white hover:opacity-90'
                      }`}
                    >
                      {sub ? `Update (v${sub.version ?? pkg.version})` : 'Install'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex flex-wrap gap-2">
        {platform.googleOAuthConfigured && !googleConnected ? (
          <button
            type="button"
            data-testid="google-sources-signin-btn"
            disabled={busy}
            onClick={() => void handleSignInGoogleForSources()}
            className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-40"
          >
            Connect Google for Sheets/Docs
          </button>
        ) : (
          <>
            <button
              type="button"
              data-testid="link-google-source-btn"
              disabled={busy || !platform.googlePickerConfigured}
              title={
                platform.googlePickerConfigured
                  ? 'Select Google Sheets or Docs with Google Picker (drive.file)'
                  : 'Configure VITE_GOOGLE_API_KEY to enable Google Picker'
              }
              onClick={() => void handleLinkGooglePicker()}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-40"
            >
              Link Google Sheet / Doc
            </button>

            <button
              type="button"
              data-testid="toggle-sheet-template-btn"
              disabled={busy || !platform.googleOAuthConfigured}
              onClick={() => setShowTemplateForm((v) => !v)}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-40"
            >
              New Sheet from Template
            </button>
          </>
        )}

        {platform.supportsLocalFolderSync && (
          <button
            type="button"
            data-testid="link-local-folder-btn"
            disabled={busy}
            onClick={() => void handleLinkLocalFolder()}
            className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-40"
          >
            Link Local Folder (PC)
          </button>
        )}

        {platform.oneDriveConfigured && platform.getOneDrivePicker && (
          <button
            type="button"
            data-testid="onedrive-import-btn"
            aria-expanded={showOneDrivePicker}
            disabled={busy}
            onClick={() => setShowOneDrivePicker((v) => !v)}
            title="Import a .csv, .tsv, .xlsx or .flashpkg file from your OneDrive, or link a spreadsheet so it refreshes"
            className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-40"
          >
            OneDrive file…
          </button>
        )}

        <button
          type="button"
          data-testid="toggle-subscribe-url-btn"
          disabled={busy}
          onClick={() => setShowSubscribeForm((v) => !v)}
          className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-40"
        >
          Subscribe to URL / Catalog
        </button>
      </div>

      {/* Optional OneDrive file picker: lazy, below the action row. The fallback reserves the
          panel's fixed height (h-[26rem], ONEDRIVE_PICKER_PANEL_HEIGHT), so nothing below moves. */}
      {showOneDrivePicker && (
        <Suspense
          fallback={
            <div
              data-testid="onedrive-picker-fallback"
              className="h-[26rem] rounded-xl border border-[var(--border)] bg-[var(--bg)]"
            />
          }
        >
          <LazyOneDrivePickerPanel
            onStatusMessage={onStatusMessage}
            onErrorMessage={onErrorMessage}
            onClose={() => setShowOneDrivePicker(false)}
            onPendingReconciliation={(held) =>
              setPendingReconciliations((prev) => [
                ...prev.filter(
                  (r) => !(r.folderId === held.folderId && r.relativePath === held.relativePath),
                ),
                held,
              ])
            }
          />
        </Suspense>
      )}

      {/* Inline Create Sheet from Template form */}
      {showTemplateForm && (
        <form
          onSubmit={(e) => void handleCreateTemplate(e)}
          className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 sm:grid-cols-4"
        >
          <input
            type="text"
            placeholder="New Google Sheet title"
            value={templateTitle}
            onChange={(e) => setTemplateTitle(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs sm:col-span-2"
          />
          <select
            aria-label="Template note type"
            value={templateNoteTypeId}
            onChange={(e) => setTemplateNoteTypeId(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs"
          >
            {noteTypes.map((nt) => (
              <option key={nt.id} value={nt.id}>
                {nt.name}
              </option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <select
              aria-label="Template language"
              value={templateLang}
              onChange={(e) => setTemplateLang(e.target.value)}
              className="w-20 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs"
            >
              <option value="ko">ko</option>
              <option value="ja">ja</option>
              <option value="zh-Hans">zh</option>
              <option value="en">en</option>
            </select>
            <button
              type="submit"
              disabled={busy || !templateTitle.trim()}
              className="flex-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              Create
            </button>
          </div>
        </form>
      )}

      {/* Inline Subscribe to .flashpkg URL / Family Library index.json form */}
      {showSubscribeForm && (
        <form
          onSubmit={(e) => void handleSubscribeUrl(e)}
          className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 sm:flex-row"
        >
          <input
            type="url"
            data-testid="subscribe-url-input"
            placeholder="https://your-host.pages.dev/deck.flashpkg or index.json"
            value={subscribeUrl}
            onChange={(e) => setSubscribeUrl(e.target.value)}
            className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs"
          />
          <select
            aria-label="Subscription URL type"
            value={subscribeKind}
            onChange={(e) => setSubscribeKind(e.target.value as 'auto' | 'package' | 'catalog')}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs"
          >
            <option value="auto">Auto-detect</option>
            <option value="package">.flashpkg Package</option>
            <option value="catalog">Family Library (index.json)</option>
          </select>
          <button
            type="submit"
            data-testid="subscribe-url-submit"
            disabled={busy || !subscribeUrl.trim()}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            Subscribe
          </button>
        </form>
      )}

      {/* .xlsx Rename Reconciliation Prompts (§3.2) */}
      {pendingReconciliations.map((rec) => {
        const key = `${rec.folderId}:${rec.relativePath}`;
        const choices = reconcileChoices[key] ?? {};
        return (
          <div
            key={key}
            data-testid="xlsx-reconcile-card"
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
          >
            <div className="font-semibold text-amber-800 dark:text-amber-200">
              Possible Renamed Rows in {rec.relativePath}
            </div>
            <p className="mt-1 text-amber-900/80 dark:text-amber-200/80">
              Match any renamed rows below to preserve FSRS review history, or leave unmatched to
              archive missing rows and add new ones.
            </p>
            <div className="mt-2 space-y-2">
              {rec.missingNotes.map((mn) => (
                <label key={mn.noteId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{mn.preview}</span>
                  <span className="text-[var(--muted)]">→</span>
                  <select
                    value={choices[mn.noteId] ?? ''}
                    onChange={(e) =>
                      setReconcileChoices((prev) => ({
                        ...prev,
                        [key]: { ...(prev[key] ?? {}), [mn.noteId]: e.target.value },
                      }))
                    }
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                  >
                    <option value="">Archive (not renamed)</option>
                    {rec.addedRows.map((ar) => (
                      <option key={ar.sortKey} value={ar.sortKey}>
                        Row {ar.rowNumber}: {ar.preview}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleApplyReconciliation(rec)}
                className="rounded-lg bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white"
              >
                Apply & Import
              </button>
            </div>
          </div>
        );
      })}

      {/* Linked Sources List */}
      {totalSources === 0 ? (
        <p className="text-xs text-[var(--muted)]">
          No external sources linked yet. Link a Google Sheet/Doc, local PC folder, or subscribe to
          a Family Library URL above.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {registry.googleSources.map((src) => (
            <div
              key={src.id}
              data-testid={`source-row-${src.fileId}`}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--muted)]">
                      {src.kind === 'google_sheets' ? 'Google Sheet' : 'Google Doc'}
                    </span>
                    <span className="truncate text-xs font-semibold">{src.name}</span>
                    {src.readOnly && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                        Read-only
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${getStatusPillClass(src.lastStatus)}`}
                    >
                      {formatStatusLabel(src.lastStatus)}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--muted)]">
                    Last synced:{' '}
                    {src.lastSyncedAt ? new Date(src.lastSyncedAt).toLocaleString() : 'Never'}
                  </div>
                  {src.lastError && (
                    <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                      {src.lastError}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {isSafeExternalGoogleUrl(src.uri) && (
                    <a
                      href={src.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--surface-2)]"
                    >
                      Open ↗
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRefreshGoogleOne(src)}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
                  >
                    Refresh
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleUnlink('google', src.id)}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-rose-600"
                  >
                    Unlink
                  </button>
                </div>
              </div>
              <WarningsDisclosure warnings={src.warnings} />
            </div>
          ))}

          {(registry.oneDriveSources ?? []).map((src) => (
            <div
              key={src.id}
              data-testid={`onedrive-source-row-${src.itemId}`}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--muted)]">
                      OneDrive
                    </span>
                    <span className="truncate text-xs font-semibold">{src.name}</span>
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                      Read-only
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${getStatusPillClass(src.lastStatus)}`}
                    >
                      {formatStatusLabel(src.lastStatus)}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--muted)]">
                    Last synced:{' '}
                    {src.lastSyncedAt ? new Date(src.lastSyncedAt).toLocaleString() : 'Never'}
                  </div>
                  {src.lastError && (
                    <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                      {src.lastError}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {src.lastStatus === 'permission_required' && (
                    <button
                      type="button"
                      data-testid={`onedrive-allow-${src.itemId}`}
                      disabled={busy}
                      onClick={() => void handleAllowOneDriveAccess()}
                      className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
                    >
                      Allow access
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRefreshOneDriveOne(src)}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
                  >
                    Refresh
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleUnlink('onedrive', src.id)}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-rose-600"
                  >
                    Unlink
                  </button>
                </div>
              </div>
              <WarningsDisclosure warnings={src.warnings} />
            </div>
          ))}

          {registry.localFolders.map((folder) => (
            <div
              key={folder.id}
              data-testid={`folder-source-row-${folder.id}`}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--muted)]">
                      Local Folder
                    </span>
                    <span className="truncate text-xs font-semibold">{folder.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${getStatusPillClass(folder.lastStatus)}`}
                    >
                      {formatStatusLabel(folder.lastStatus)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-[var(--muted)]">
                    <span>
                      Last scanned:{' '}
                      {folder.lastScannedAt
                        ? new Date(folder.lastScannedAt).toLocaleString()
                        : 'Never'}
                    </span>
                    <span>{Object.keys(folder.files).length} tracked file(s)</span>
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={folder.writeCardIds}
                        onChange={(e) =>
                          void handleToggleFolderWriteCardIds(folder, e.target.checked)
                        }
                      />
                      Write Card IDs to CSV/TSV
                    </label>
                  </div>
                  {folder.lastError && (
                    <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                      {folder.lastError}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRefreshFolderOne(folder)}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
                  >
                    {folder.lastStatus === 'permission_required' ? 'Reconnect' : 'Scan'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleUnlink('folder', folder.id)}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-rose-600"
                  >
                    Unlink
                  </button>
                </div>
              </div>
              <WarningsDisclosure warnings={folder.warnings} />
            </div>
          ))}

          {registry.packageSubscriptions.map((sub) => (
            <div
              key={sub.id}
              data-testid={`pkg-sub-row-${sub.packageId ?? sub.id}`}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--muted)]">
                      Package URL
                    </span>
                    <span className="truncate text-xs font-semibold">{sub.title}</span>
                    {sub.version && (
                      <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--muted)]">
                        v{sub.version}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${getStatusPillClass(sub.lastStatus)}`}
                    >
                      {formatStatusLabel(sub.lastStatus)}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-[var(--muted)]">
                    {sub.url} · Checked:{' '}
                    {sub.lastSyncedAt ? new Date(sub.lastSyncedAt).toLocaleString() : 'Never'}
                  </div>
                  {sub.lastError && (
                    <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                      {sub.lastError}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRefreshPackageOne(sub)}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
                  >
                    Check Update
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleUnlink('package', sub.id)}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-rose-600"
                  >
                    Unlink
                  </button>
                </div>
              </div>
              <WarningsDisclosure warnings={sub.warnings} />
            </div>
          ))}

          {/* Family Library Catalogs (§3.4) */}
          {registry.catalogs.map((cat) => (
            <div
              key={cat.id}
              data-testid="family-catalog-card"
              className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--muted)]">
                      Family Library
                    </span>
                    <span className="text-xs font-semibold">{cat.name}</span>
                  </div>
                  {cat.description && (
                    <p className="mt-0.5 text-[11px] text-[var(--muted)]">{cat.description}</p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleUnlink('catalog', cat.id)}
                  className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-rose-600"
                >
                  Remove
                </button>
              </div>

              <div className="mt-2.5 flex flex-col gap-1.5">
                {cat.packages.map((pkg) => {
                  const sub = registry.packageSubscriptions.find(
                    (s) => s.url === pkg.url || s.packageId === pkg.package_id,
                  );
                  return (
                    <div
                      key={pkg.package_id}
                      data-testid={`catalog-pkg-${pkg.package_id}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium">{pkg.title}</span>
                          <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
                            v{pkg.version}
                          </span>
                          {pkg.languages.map((lang) => (
                            <span
                              key={lang}
                              className="rounded bg-[var(--surface-2)] px-1 py-0.5 text-[10px] text-[var(--muted)]"
                            >
                              {lang}
                            </span>
                          ))}
                        </div>
                        {pkg.description && (
                          <div className="text-[11px] text-[var(--muted)]">{pkg.description}</div>
                        )}
                      </div>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSubscribeCatalogEntry(cat.url, pkg)}
                        className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                          sub
                            ? 'border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-2)]'
                            : 'bg-[var(--accent)] text-white hover:opacity-90'
                        }`}
                      >
                        {sub ? `Update (${sub.version ?? 'subscribed'})` : 'Subscribe'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Imported Pages Summary (Google Docs & Local .md) */}
      {importedPages.length > 0 && (
        <div
          data-testid="imported-pages-summary"
          className="border-t border-[var(--border)] pt-3 text-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Imported Pages ({importedPages.length})</span>
            <span className="text-[11px] text-[var(--muted)]">
              Cached offline · open in Lesson Pages below
            </span>
          </div>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {importedPages.map((p) => (
              <li
                key={p.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1 text-[11px]"
              >
                {p.title}
                {p.source?.kind === 'google_docs'
                  ? ' (Doc)'
                  : p.source?.kind === 'local_file'
                    ? ' (.md)'
                    : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
