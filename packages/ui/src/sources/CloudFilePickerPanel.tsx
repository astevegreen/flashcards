import type { CollectionState, Deck } from '@flash/core';
import { canCreateOrImportDeck } from '@flash/core/license';
import type { PendingXlsxReconciliation, PickedFile, PlatformServices } from '@flash/platform';
import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { lazyWithRetry } from '../lazy/lazyWithRetry.tsx';
import { useApp } from '../state/AppContext.tsx';
import type { SourceRunContext } from './sourceRunner.ts';
import type { LinkedFileMappingChoice } from './LinkedFileMapping.tsx';
import { importPickedCloudFile } from './oneDriveImport.ts';

const LazyLinkedFileMapping = lazyWithRetry(() => import('./LinkedFileMapping.tsx'), {
  closeWith: 'onCancel',
});
const LINKABLE = /\.(csv|tsv|xlsx)$/i;

/** The panel's height in every state; the lazy-load fallback in SourcesPanel reserves the same. */
export const CLOUD_PICKER_PANEL_HEIGHT = 'h-[26rem]';

/** The fields of a folder-listing entry that the panel uses (OneDrive and Dropbox both have them). */
export interface CloudBrowseItem {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size: number;
}

/** A cloud drive's picker calls, bound to its loaded picker. */
export interface CloudPickerSession<Item extends CloudBrowseItem> {
  hasAccess(): Promise<boolean>;
  /** Web navigates to the provider's sign-in; native shells return once the user consents. */
  requestAccess(): Promise<boolean>;
  listFolder(folder?: string): Promise<Item[]>;
  downloadFile(item: Item): Promise<PickedFile>;
}

/** Everything that differs between the OneDrive and Dropbox pickers. */
export interface CloudPickerProvider<Item extends CloudBrowseItem> {
  /** Prefix for test ids, e.g. `onedrive`. */
  key: string;
  /** The drive's name in copy, e.g. `OneDrive`. */
  label: string;
  /** The first breadcrumb. */
  rootName: string;
  open(platform: PlatformServices): Promise<CloudPickerSession<Item>>;
  /** The handle `listFolder` takes to browse into this folder. */
  folderOf(item: Item): string;
  linkedDeck(state: CollectionState, fileId: string): Deck | undefined;
  link(
    item: Item,
    ctx: SourceRunContext,
    choice: LinkedFileMappingChoice,
  ): Promise<{ notesTouched: number; pending?: PendingXlsxReconciliation }>;
  /** Optional line under the title. */
  intro?: ReactNode;
  /** Shown with the access button before the drive can be browsed. */
  accessText: ReactNode;
  accessButton: { label: string; testId: string };
  emptyText: string;
}

type AccessState = 'checking' | 'needed' | 'ready' | 'error';

interface FolderCrumb {
  folder?: string;
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

/** Status-slot text: an error wins, then the connection/listing state. */
function statusText(
  label: string,
  access: AccessState,
  loading: boolean,
  path: readonly FolderCrumb[],
  panelError: string | null,
): string {
  if (panelError) return panelError;
  if (access === 'checking') return `Connecting to ${label}…`;
  if (access !== 'ready') return '';
  return loading ? 'Loading…' : path.map((p) => p.name).join(' / ');
}

/**
 * Cloud-drive file picker (OneDrive, Dropbox), lazy-loaded below the Sources action row. Browses
 * the drive and imports one `.csv`, `.tsv`, `.xlsx` or `.flashpkg` file, or links a spreadsheet so
 * it refreshes like a Google Sheet. The panel has ONE fixed height in every state (connecting,
 * access needed, listing, error), and the Suspense fallback in SourcesPanel uses the same height,
 * so the linked-source rows below it never move after async work. Errors render inside the fixed
 * status slot, never above the interactive rows.
 */
export function CloudFilePickerPanel<Item extends CloudBrowseItem>({
  provider,
  onStatusMessage,
  onErrorMessage,
  onClose,
  onPendingReconciliation,
}: Readonly<{
  provider: CloudPickerProvider<Item>;
  onStatusMessage: (msg: string) => void;
  onErrorMessage: (msg: string) => void;
  onClose: () => void;
  /** Hands a held rename review to the Sources panel, which shows the prompt. */
  onPendingReconciliation?: (rec: PendingXlsxReconciliation) => void;
}>) {
  const { platform, state, stateVersion, entitlement, getEventFactory, emitEvents, createDeck } =
    useApp();
  const { key, label } = provider;
  const [session, setSession] = useState<CloudPickerSession<Item> | null>(null);
  const [access, setAccess] = useState<AccessState>('checking');
  const [path, setPath] = useState<FolderCrumb[]>([{ name: provider.rootName }]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [language, setLanguage] = useState('ko');
  const [linking, setLinking] = useState<{ item: Item; grid: string[][]; busy: boolean } | null>(
    null,
  );

  const noteTypes = useMemo(
    () => [...state.noteTypes.values()],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );
  const [chosenNoteTypeId, setChosenNoteTypeId] = useState<string | undefined>(undefined);
  // The Korean vocab preset when present, else the first note type the select shows.
  const noteTypeId =
    [chosenNoteTypeId, 'preset:vocab-ko'].find((id) => id && state.noteTypes.has(id)) ??
    noteTypes[0]?.id ??
    '';
  const currentFolder = path.at(-1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const opened = await provider.open(platform);
        const granted = await opened.hasAccess();
        if (cancelled) return;
        setSession(opened);
        setAccess(granted ? 'ready' : 'needed');
      } catch (err) {
        if (cancelled) return;
        setAccess('error');
        setPanelError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [platform, provider]);

  useEffect(() => {
    if (!session || access !== 'ready') return undefined;
    let cancelled = false;
    setLoading(true);
    setPanelError(null);
    session
      .listFolder(currentFolder?.folder)
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
  }, [session, access, currentFolder?.folder]);

  const handleRequestAccess = async () => {
    if (!session) return;
    setPanelError(null);
    try {
      if (await session.requestAccess()) setAccess('ready');
    } catch (err) {
      setPanelError(errorText(err));
    }
  };

  const handleImport = async (item: Item) => {
    if (!session) return;
    setBusyItemId(item.id);
    setPanelError(null);
    try {
      const picked = await session.downloadFile(item);
      const message = await importPickedCloudFile(
        picked,
        {
          platform,
          state,
          entitlement,
          getEventFactory,
          emitEvents,
          createDeck,
          noteTypeId,
          language,
        },
        label,
      );
      onStatusMessage(message);
    } catch (err) {
      onErrorMessage(errorText(err));
    } finally {
      setBusyItemId(null);
    }
  };

  /** Downloads a spreadsheet and opens the column-mapping step to link it as a source. */
  const handleStartLink = async (item: Item) => {
    if (!session) return;
    setBusyItemId(item.id);
    setPanelError(null);
    try {
      const picked = await session.downloadFile(item);
      const { readOneDriveTable } = await import('./sourceRunner.ts');
      setLinking({ item, grid: await readOneDriveTable(platform, picked), busy: false });
    } catch (err) {
      setPanelError(errorText(err));
    } finally {
      setBusyItemId(null);
    }
  };

  const handleConfirmLink = async (choice: LinkedFileMappingChoice) => {
    if (!linking) return;
    const { item } = linking;
    if (!provider.linkedDeck(state, item.id)) {
      const gate = canCreateOrImportDeck(activeDeckCount(state), entitlement);
      if (!gate.allowed) {
        setPanelError(gate.reason ?? 'Free tier deck limit reached.');
        return;
      }
    }
    setLinking({ ...linking, busy: true });
    setPanelError(null);
    try {
      const res = await provider.link(
        item,
        { platform, getState: () => state, getEventFactory, emitEvents },
        choice,
      );
      if (res.pending) onPendingReconciliation?.(res.pending);
      onStatusMessage(
        res.pending
          ? `Linked "${item.name}", but some rows look renamed. Match them in the prompt below to keep review history.`
          : `Linked "${item.name}" from ${label}: ${res.notesTouched} note change(s). It refreshes with your other sources.`,
      );
      setLinking(null);
    } catch (err) {
      setPanelError(errorText(err));
      setLinking({ ...linking, busy: false });
    }
  };

  return (
    <div
      data-testid={`${key}-picker-panel`}
      className={`flex ${CLOUD_PICKER_PANEL_HEIGHT} flex-col gap-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">Import or link a {label} file</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-2)]"
        >
          Close
        </button>
      </div>

      {provider.intro && <p className="text-[11px] text-[var(--muted)]">{provider.intro}</p>}

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
        <span>New decks from .csv/.tsv/.xlsx use</span>
        <select
          aria-label={`${label} import note type`}
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
          aria-label={`${label} import language`}
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
        {statusText(label, access, loading, path, panelError)}
      </div>

      {/* The body fills the rest of the fixed panel height in every state. */}
      <div className="min-h-0 flex-1">
        {access === 'needed' && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[11px] text-[var(--muted)]">{provider.accessText}</p>
            <button
              type="button"
              data-testid={provider.accessButton.testId}
              onClick={() => void handleRequestAccess()}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 font-semibold text-white hover:opacity-90"
            >
              {provider.accessButton.label}
            </button>
          </div>
        )}

        {access === 'ready' && linking && (
          <Suspense fallback={null}>
            <LazyLinkedFileMapping
              key={linking.item.id}
              fileName={linking.item.name}
              grid={linking.grid}
              existingDeck={provider.linkedDeck(state, linking.item.id)}
              busy={linking.busy}
              testIdPrefix={key}
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
                  data-testid={`${key}-up-btn`}
                  onClick={() => setPath((prev) => prev.slice(0, -1))}
                  className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-[var(--surface-2)]"
                >
                  ← Back
                </button>
              </li>
            )}
            {!loading && items.length === 0 && (
              <li className="px-2 py-1.5 text-[var(--muted)]">{provider.emptyText}</li>
            )}
            {items.map((item) => (
              <li key={item.id}>
                {item.kind === 'folder' ? (
                  <button
                    type="button"
                    data-testid={`${key}-folder-${item.name}`}
                    onClick={() =>
                      setPath((prev) => [
                        ...prev,
                        { folder: provider.folderOf(item), name: item.name },
                      ])
                    }
                    className="w-full rounded-lg px-2 py-1.5 text-left font-medium hover:bg-[var(--surface-2)]"
                  >
                    {item.name}/
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-testid={`${key}-file-${item.name}`}
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
                        data-testid={`${key}-link-${item.name}`}
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
