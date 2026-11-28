import { useEffect, useId, useRef } from 'react';
import type { ArchivePreviewRequest } from './sourcesRegistry.ts';

export interface ArchivePreviewDialogProps {
  request: ArchivePreviewRequest;
  /** `true` for Continue; `false` for Cancel, Escape or a click outside. Called once. */
  onAnswer: (proceed: boolean) => void;
}

/**
 * The step before a package re-import that archives notes (C9): how many notes the update would
 * archive with their review progress, and Continue or Cancel. Cancel writes nothing. A native
 * modal `<dialog>` opened with `showModal()` (Escape closes it as Cancel). Loaded lazily by the
 * Sources panel, only when an update would archive at least one note.
 */
export default function ArchivePreviewDialog({
  request,
  onAnswer,
}: Readonly<ArchivePreviewDialogProps>) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const answeredRef = useRef(false);
  const titleId = useId();
  const { sourceName, notesArchived, fileName } = request;
  const notes = notesArchived === 1 ? '1 note' : `${notesArchived} notes`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const answer = (proceed: boolean) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    onAnswer(proceed);
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      data-testid="archive-preview-dialog"
      className="flash-dialog m-auto w-[min(92vw,28rem)] rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--fg)] shadow-2xl"
      onClose={() => answer(false)}
    >
      <h2 id={titleId} className="text-base font-semibold">
        Archive {notes}?
      </h2>
      <p className="mt-2 text-sm text-[var(--muted)]">
        The new version of “{sourceName}” no longer has {notes} you have. Updating archives{' '}
        {notesArchived === 1 ? 'it' : 'them'} with {notesArchived === 1 ? 'its' : 'their'} review
        progress. Cancel leaves this deck as it is.
      </p>
      {fileName && (
        <p data-testid="archive-preview-file" className="mt-1 truncate text-xs text-[var(--muted)]">
          From {fileName}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          autoFocus
          className="min-h-11 rounded-xl border border-[var(--border)] px-4 text-sm"
          onClick={() => {
            answer(false);
            dialogRef.current?.close();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="min-h-11 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-white"
          onClick={() => {
            answer(true);
            dialogRef.current?.close();
          }}
        >
          Continue
        </button>
      </div>
    </dialog>
  );
}
