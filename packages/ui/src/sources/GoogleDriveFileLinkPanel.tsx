import { canCreateOrImportDeck } from '@flash/core/license';
import type { PendingXlsxReconciliation, SourcesRegistry } from '@flash/platform';
import { Suspense, useEffect, useState } from 'react';
import { lazyWithRetry } from '../lazy/lazyWithRetry.tsx';
import { useApp } from '../state/AppContext.tsx';
import {
  downloadGoogleDriveFile,
  linkGoogleDriveFile,
  readGoogleDriveTable,
  type PickedDriveFile,
} from './googleDriveFileSource.ts';
import { linkedFileDeck } from './linkedFileDeck.ts';
import type { LinkedFileMappingChoice } from './LinkedFileMapping.tsx';

const LazyLinkedFileMapping = lazyWithRetry(() => import('./LinkedFileMapping.tsx'), {
  closeWith: 'onCancel',
});

type Step =
  | { kind: 'loading' }
  | { kind: 'mapping'; grid: string[][] }
  | { kind: 'package' }
  | { kind: 'error'; message: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function activeDeckCount(state: { decks: ReadonlyMap<string, { archived: boolean }> }): number {
  let count = 0;
  for (const deck of state.decks.values()) if (!deck.archived) count += 1;
  return count;
}

/**
 * Links the plain files picked with "Link from Google Drive", one at a time: a `.csv` / `.tsv` /
 * `.xlsx` is downloaded and shown in the column-mapping step (like a linked OneDrive file); a
 * `.flashpkg` links with one tap. Lazy-loaded below the Sources action row.
 */
export default function GoogleDriveFileLinkPanel({
  files,
  onClose,
  onStatusMessage,
  onErrorMessage,
  onPendingReconciliation,
  onRegistry,
}: Readonly<{
  files: readonly PickedDriveFile[];
  onClose: () => void;
  onStatusMessage: (msg: string) => void;
  onErrorMessage: (msg: string | null) => void;
  onPendingReconciliation: (rec: PendingXlsxReconciliation) => void;
  onRegistry: (registry: SourcesRegistry) => void;
}>) {
  const { platform, state, entitlement, getEventFactory, emitEvents } = useApp();
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const file = files[index];

  useEffect(() => {
    if (!file) {
      onClose();
      return undefined;
    }
    let cancelled = false;
    if (file.format === 'flashpkg') {
      setStep({ kind: 'package' });
      return undefined;
    }
    setStep({ kind: 'loading' });
    void (async () => {
      try {
        const picked = await downloadGoogleDriveFile(platform, file.id);
        const grid = await readGoogleDriveTable(platform, picked);
        if (!cancelled) setStep({ kind: 'mapping', grid });
      } catch (err) {
        if (!cancelled) setStep({ kind: 'error', message: errorText(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, platform]);

  if (!file) return null;

  const next = () => setIndex((i) => i + 1);

  const link = async (choice?: LinkedFileMappingChoice) => {
    const isNewDeck =
      file.format === 'flashpkg' || !linkedFileDeck(state, 'google_drive_file', file.id);
    if (isNewDeck) {
      const gate = canCreateOrImportDeck(activeDeckCount(state), entitlement);
      if (!gate.allowed) {
        setStep({ kind: 'error', message: gate.reason ?? 'Free tier deck limit reached.' });
        return;
      }
    }
    setBusy(true);
    onErrorMessage(null);
    try {
      const res = await linkGoogleDriveFile(
        file,
        { platform, getState: () => state, getEventFactory, emitEvents, entitlement },
        choice,
      );
      onRegistry(res.registry);
      if (res.pending) onPendingReconciliation(res.pending);
      onStatusMessage(
        res.pending
          ? `Linked "${file.name}", but some rows look renamed. Match them in the prompt below to keep review history.`
          : `Linked "${file.name}" from Google Drive: ${res.notesTouched} note change(s). It refreshes with your other sources.`,
      );
      next();
    } catch (err) {
      setStep({ kind: 'error', message: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="gdrive-file-link-panel"
      className="flex max-h-[32rem] min-h-[12rem] flex-col gap-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">
          Link Google Drive files{files.length > 1 ? ` (${index + 1} of ${files.length})` : ''}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-2)] disabled:opacity-40"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {step.kind === 'loading' && (
          <p role="status" className="text-[11px] text-[var(--muted)]">
            Reading “{file.name}” from Google Drive…
          </p>
        )}

        {step.kind === 'error' && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-400">
              {step.message}
            </p>
            <button
              type="button"
              data-testid="gdrive-file-skip-btn"
              onClick={next}
              className="rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-2)]"
            >
              {index + 1 < files.length ? 'Skip this file' : 'Done'}
            </button>
          </div>
        )}

        {step.kind === 'package' && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[11px] text-[var(--muted)]">
              “{file.name}” is a deck package. Linking imports its decks now and re-imports them
              whenever the file changes in Google Drive (your review history is kept).
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="gdrive-package-link-btn"
                disabled={busy}
                onClick={() => void link()}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 font-semibold text-white hover:opacity-90 disabled:opacity-40"
              >
                {busy ? 'Linking…' : 'Link this package'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={next}
                className="rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-2)] disabled:opacity-40"
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {step.kind === 'mapping' && (
          <Suspense fallback={null}>
            <LazyLinkedFileMapping
              key={file.id}
              fileName={file.name}
              grid={step.grid}
              existingDeck={linkedFileDeck(state, 'google_drive_file', file.id)}
              busy={busy}
              testIdPrefix="gdrive"
              cancelLabel="Skip"
              onLink={(choice) => void link(choice)}
              onCancel={next}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
