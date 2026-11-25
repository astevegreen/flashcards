import type { SourceColumnMapping } from '@flash/core';
import { canCreateOrImportDeck } from '@flash/core/license';
import type {
  DropboxBrowseItem,
  DropboxFilePicker,
  PendingXlsxReconciliation,
} from '@flash/platform';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { lazyWithRetry } from '../lazy/lazyWithRetry.tsx';
import { useApp } from '../state/AppContext.tsx';
import { importPickedDropboxFile } from './dropboxImport.ts';
import { linkedDropboxDeck } from './dropboxLinkedDeck.ts';

const LazyDropboxLinkMapping = lazyWithRetry(() => import('./DropboxLinkMapping.tsx'), {
  closeWith: 'onCancel',
});
const LINKABLE = /\.(csv|tsv|xlsx)$/i;

type AccessState = 'checking' | 'needed' | 'ready' | 'error';

interface FolderCrumb {
  path?: string;
  name: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function activeDeckCount(state: { decks: ReadonlyMap<string, { archived: boolean }> }): number {
  let count = 0;
  for (const deck of state.decks.values()) if (!deck.archived) count += 1;
  return count;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The panel's height in every state; the lazy-load fallback reserves the same. */
export const DROPBOX_PICKER_PANEL_HEIGHT = 'h-[26rem]';

function statusText(
  access: AccessState,
  loading: boolean,
  path: readonly FolderCrumb[],
  panelError: string | null,
): string {
  if (panelError) return panelError;
  if (access === 'checking') return 'Connecting to Dropbox…';
  if (access !== 'ready') return '';
  return loading ? 'Loading…' : path.map((p) => p.name).join(' / ');
}

/**
 * Dropbox App Folder file picker, lazy-loaded below the Sources action row.
 * Browses `Dropbox › Apps › Flashcards` (excluding internal sync folders) and imports or links
 * `.csv`, `.tsv`, `.xlsx`, or imports `.flashpkg` files. Reuses the same Dropbox sign-in as sync.
 */
export default function DropboxPickerPanel({
  onStatusMessage,
  onErrorMessage,
  onClose,
  onPendingReconciliation,
}: Readonly<{
  onStatusMessage: (msg: string) => void;
  onErrorMessage: (msg: string) => void;
  onClose: () => void;
  onPendingReconciliation?: (rec: PendingXlsxReconciliation) => void;
}>) {
  const { platform, state, stateVersion, entitlement, getEventFactory, emitEvents, createDeck } =
    useApp();
  const [picker, setPicker] = useState<DropboxFilePicker | null>(null);
  const [access, setAccess] = useState<AccessState>('checking');
  const [path, setPath] = useState<FolderCrumb[]>([{ name: 'Dropbox App Folder' }]);
  const [items, setItems] = useState<DropboxBrowseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [language, setLanguage] = useState('ko');
  const [linking, setLinking] = useState<{
    item: DropboxBrowseItem;
    grid: string[][];
    busy: boolean;
  } | null>(null);

  const noteTypes = useMemo(
    () => [...state.noteTypes.values()],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );
  const [chosenNoteTypeId, setChosenNoteTypeId] = useState<string | undefined>(undefined);
  const noteTypeId =
    [chosenNoteTypeId, 'preset:vocab-ko'].find((id) => id && state.noteTypes.has(id)) ??
    noteTypes[0]?.id ??
    '';
  const currentFolder = path.at(-1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!platform.getDropboxPicker) {
          throw new Error('Dropbox is not available in this build.');
        }
        const loaded = await platform.getDropboxPicker();
        const connected = await loaded.isConnected();
        if (cancelled) return;
        setPicker(loaded);
        setAccess(connected ? 'ready' : 'needed');
      } catch (err) {
        if (cancelled) return;
        setAccess('error');
        setPanelError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    if (!picker || access !== 'ready') return undefined;
    let cancelled = false;
    setLoading(true);
    setPanelError(null);
    picker
      .listFolder(currentFolder?.path)
      .then((listed) => {
        if (!cancelled) setItems(listed);
      })
      .catch((err: unknown) => {
        if (!cancelled) setPanelError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [picker, access, currentFolder?.path]);

  const handleConnect = async () => {
    if (!picker) return;
    setPanelError(null);
    try {
      // Web navigates to Dropbox sign-in; native shells return once the user consents.
      if (await picker.connect()) setAccess('ready');
    } catch (err) {
      setPanelError(errorText(err));
    }
  };

  const handleImport = async (item: DropboxBrowseItem) => {
    if (!picker) return;
    setBusyItemId(item.id);
    setPanelError(null);
    try {
      const picked = await picker.downloadFile(item);
      const message = await importPickedDropboxFile(picked, {
        platform,
        state,
        entitlement,
        getEventFactory,
        emitEvents,
        createDeck,
        noteTypeId,
        language,
      });
      onStatusMessage(message);
    } catch (err) {
      onErrorMessage(errorText(err));
    } finally {
      setBusyItemId(null);
    }
  };

  const handleStartLink = async (item: DropboxBrowseItem) => {
    if (!picker) return;
    setBusyItemId(item.id);
    setPanelError(null);
    try {
      const picked = await picker.downloadFile(item);
      const { readOneDriveTable } = await import('./sourceRunner.ts');
      setLinking({ item, grid: await readOneDriveTable(platform, picked), busy: false });
    } catch (err) {
      setPanelError(errorText(err));
    } finally {
      setBusyItemId(null);
    }
  };

  const handleConfirmLink = async (choice: {
    noteTypeId: string;
    language: string;
    columnMap: SourceColumnMapping[];
  }) => {
    if (!linking) return;
    const { item } = linking;
    if (!linkedDropboxDeck(state, item.id)) {
      const gate = canCreateOrImportDeck(activeDeckCount(state), entitlement);
      if (!gate.allowed) {
        setPanelError(gate.reason ?? 'Free tier deck limit reached.');
        return;
      }
    }
    setLinking({ ...linking, busy: true });
    setPanelError(null);
    try {
      const { linkDropboxFile } = await import('./sourceRunner.ts');
      const res = await linkDropboxFile(
        { id: item.id, name: item.name, pathDisplay: item.pathDisplay },
        { platform, getState: () => state, getEventFactory, emitEvents },
        choice,
      );
      if (res.pending) onPendingReconciliation?.(res.pending);
      onStatusMessage(
        res.pending
          ? `Linked "${item.name}", but some rows look renamed. Match them in the prompt below to keep review history.`
          : `Linked "${item.name}" from Dropbox: ${res.notesTouched} note change(s). It refreshes with your other sources.`,
      );
      setLinking(null);
    } catch (err) {
      setPanelError(errorText(err));
      setLinking({ ...linking, busy: false });
    }
  };

  return (
    <div
      data-testid="dropbox-picker-panel"
      className={`flex ${DROPBOX_PICKER_PANEL_HEIGHT} flex-col gap-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">Import or link a Dropbox file</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-2)]"
        >
          Close
        </button>
      </div>

      <p className="text-[11px] text-[var(--muted)]">
        Put spreadsheets (<code>.csv</code>, <code>.tsv</code>, <code>.xlsx</code>) or{' '}
        <code>.flashpkg</code> files in <strong>Dropbox › Apps › Flashcards</strong>. App sync
        folders are hidden.
      </p>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
        <span>New decks from .csv/.tsv/.xlsx use</span>
        <select
          aria-label="Dropbox import note type"
          value={noteTypeId}
          onChange={(e) => setChosenNoteTypeId(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
        >
          {noteTypes.map((nt) => (
            <option key={nt.id} value={nt.id}>
              {nt.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Dropbox import language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
        >
          <option value="ko">ko</option>
          <option value="ja">ja</option>
          <option value="zh-Hans">zh</option>
          <option value="en">en</option>
        </select>
      </div>

      {/* Fixed-height status slot (two lines): status and error text never move the rows below. */}
      <div
        role={panelError ? 'alert' : 'status'}
        title={panelError ?? undefined}
        className={`line-clamp-2 h-8 shrink-0 text-[11px] ${
          panelError ? 'text-rose-600 dark:text-rose-400' : 'text-[var(--muted)]'
        }`}
      >
        {statusText(access, loading, path, panelError)}
      </div>

      <div className="min-h-0 flex-1">
        {access === 'needed' && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[11px] text-[var(--muted)]">
              Connect Dropbox to browse your app folder. The app can only see its own{' '}
              <strong>Dropbox › Apps › Flashcards</strong> folder—never the rest of your Dropbox.
              One sign-in works for both sync and linked files.
            </p>
            <button
              type="button"
              data-testid="dropbox-connect-btn"
              onClick={() => void handleConnect()}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 font-semibold text-white hover:opacity-90"
            >
              Connect Dropbox
            </button>
          </div>
        )}

        {access === 'ready' && linking && (
          <Suspense fallback={null}>
            <LazyDropboxLinkMapping
              fileId={linking.item.id}
              fileName={linking.item.name}
              grid={linking.grid}
              busy={linking.busy}
              onLink={(c) => void handleConfirmLink(c)}
              onCancel={() => setLinking(null)}
            />
          </Suspense>
        )}

        {access === 'ready' && !linking && (
          <ul className="flex h-full flex-col gap-1 overflow-y-auto">
            {path.length > 1 && (
              <li>
                <button
                  type="button"
                  data-testid="dropbox-up-btn"
                  onClick={() => setPath((prev) => prev.slice(0, -1))}
                  className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-[var(--surface-2)]"
                >
                  ← Back
                </button>
              </li>
            )}
            {!loading && items.length === 0 && (
              <li className="px-2 py-1.5 text-[var(--muted)]">
                No folders or importable files here. Add files to Dropbox › Apps › Flashcards.
              </li>
            )}
            {items.map((item) => (
              <li key={item.id}>
                {item.kind === 'folder' ? (
                  <button
                    type="button"
                    data-testid={`dropbox-folder-${item.name}`}
                    onClick={() =>
                      setPath((prev) => [...prev, { path: item.pathLower, name: item.name }])
                    }
                    className="w-full rounded-lg px-2 py-1.5 text-left font-medium hover:bg-[var(--surface-2)]"
                  >
                    {item.name}/
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-testid={`dropbox-file-${item.name}`}
                      disabled={busyItemId !== null}
                      onClick={() => void handleImport(item)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--surface-2)] disabled:opacity-50"
                    >
                      <span className="truncate">{item.name}</span>
                      <span className="shrink-0 text-[var(--muted)]">
                        {busyItemId === item.id ? 'Working…' : formatSize(item.size)}
                      </span>
                    </button>
                    {LINKABLE.test(item.name) && (
                      <button
                        type="button"
                        data-testid={`dropbox-link-${item.name}`}
                        disabled={busyItemId !== null}
                        title="Link this file so it refreshes like a Google Sheet"
                        onClick={() => void handleStartLink(item)}
                        className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-2)] disabled:opacity-50"
                      >
                        Link
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
