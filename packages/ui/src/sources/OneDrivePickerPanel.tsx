import type { OneDriveBrowseItem, OneDriveFilePicker } from '@flash/platform';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { importPickedOneDriveFile } from './oneDriveImport.ts';

type AccessState = 'checking' | 'needed' | 'ready' | 'error';

interface FolderCrumb {
  id?: string;
  name: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Optional OneDrive file picker (§15 Phase 12), lazy-loaded below the Sources action row. Browses
 * the user's OneDrive (read-only `Files.Read`, asked for only here) and imports one `.csv`, `.tsv`,
 * `.xlsx` or `.flashpkg` file. The panel keeps a fixed minimum height while it loads so nothing
 * under it jumps when the listing arrives.
 */
export default function OneDrivePickerPanel({
  onStatusMessage,
  onErrorMessage,
  onClose,
}: Readonly<{
  onStatusMessage: (msg: string) => void;
  onErrorMessage: (msg: string) => void;
  onClose: () => void;
}>) {
  const { platform, state, stateVersion, entitlement, getEventFactory, emitEvents, createDeck } =
    useApp();
  const [picker, setPicker] = useState<OneDriveFilePicker | null>(null);
  const [access, setAccess] = useState<AccessState>('checking');
  const [path, setPath] = useState<FolderCrumb[]>([{ name: 'OneDrive' }]);
  const [items, setItems] = useState<OneDriveBrowseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [noteTypeId, setNoteTypeId] = useState('preset:vocab-ko');
  const [language, setLanguage] = useState('ko');

  const noteTypes = useMemo(
    () => [...state.noteTypes.values()],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );
  const currentFolder = path.at(-1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!platform.getOneDrivePicker)
          throw new Error('OneDrive is not available in this build.');
        const loaded = await platform.getOneDrivePicker();
        const granted = await loaded.hasFileAccess();
        if (cancelled) return;
        setPicker(loaded);
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
  }, [platform]);

  useEffect(() => {
    if (!picker || access !== 'ready') return undefined;
    let cancelled = false;
    setLoading(true);
    setPanelError(null);
    picker
      .listFolder(currentFolder?.id)
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
  }, [picker, access, currentFolder?.id]);

  const handleGrantAccess = async () => {
    if (!picker) return;
    setPanelError(null);
    try {
      // Web navigates to Microsoft sign-in; native shells return once the user consents.
      if (await picker.requestFileAccess()) setAccess('ready');
    } catch (err) {
      setPanelError(errorText(err));
    }
  };

  const handleImport = async (item: OneDriveBrowseItem) => {
    if (!picker) return;
    setBusyItemId(item.id);
    setPanelError(null);
    try {
      const picked = await picker.downloadFile(item);
      const message = await importPickedOneDriveFile(picked, {
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

  return (
    <div
      data-testid="onedrive-picker-panel"
      className="flex min-h-[16rem] flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">Import from OneDrive</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-2)]"
        >
          Close
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
        <span>New decks from .csv/.tsv/.xlsx use</span>
        <select
          aria-label="OneDrive import note type"
          value={noteTypeId}
          onChange={(e) => setNoteTypeId(e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
        >
          {noteTypes.map((nt) => (
            <option key={nt.id} value={nt.id}>
              {nt.name}
            </option>
          ))}
        </select>
        <select
          aria-label="OneDrive import language"
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

      {/* Fixed-height status line: text changes never move the list below it. */}
      <div role="status" className="min-h-[1.25rem] text-[11px] text-[var(--muted)]">
        {access === 'checking' && 'Connecting to OneDrive…'}
        {access === 'ready' && loading && 'Loading…'}
        {access === 'ready' && !loading && path.map((p) => p.name).join(' / ')}
      </div>

      {panelError && (
        <div role="alert" className="text-[11px] text-rose-600 dark:text-rose-400">
          {panelError}
        </div>
      )}

      {access === 'needed' && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[11px] text-[var(--muted)]">
            Sync only sees the app&apos;s own OneDrive folder. To pick a file, allow read-only
            access to your OneDrive files once.
          </p>
          <button
            type="button"
            data-testid="onedrive-grant-access-btn"
            onClick={() => void handleGrantAccess()}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 font-semibold text-white hover:opacity-90"
          >
            Allow OneDrive file access
          </button>
        </div>
      )}

      {access === 'ready' && (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {path.length > 1 && (
            <li>
              <button
                type="button"
                data-testid="onedrive-up-btn"
                onClick={() => setPath((prev) => prev.slice(0, -1))}
                className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-[var(--surface-2)]"
              >
                ← Back
              </button>
            </li>
          )}
          {!loading && items.length === 0 && (
            <li className="px-2 py-1.5 text-[var(--muted)]">
              No folders or importable files here.
            </li>
          )}
          {items.map((item) => (
            <li key={item.id}>
              {item.kind === 'folder' ? (
                <button
                  type="button"
                  data-testid={`onedrive-folder-${item.name}`}
                  onClick={() => setPath((prev) => [...prev, { id: item.id, name: item.name }])}
                  className="w-full rounded-lg px-2 py-1.5 text-left font-medium hover:bg-[var(--surface-2)]"
                >
                  {item.name}/
                </button>
              ) : (
                <button
                  type="button"
                  data-testid={`onedrive-file-${item.name}`}
                  disabled={busyItemId !== null}
                  onClick={() => void handleImport(item)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--surface-2)] disabled:opacity-50"
                >
                  <span className="truncate">{item.name}</span>
                  <span className="shrink-0 text-[var(--muted)]">
                    {busyItemId === item.id ? 'Importing…' : formatSize(item.size)}
                  </span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
