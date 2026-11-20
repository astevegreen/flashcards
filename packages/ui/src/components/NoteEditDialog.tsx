import type { Note, NoteType } from '@flash/core';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

export interface NoteEditDialogProps {
  note: Note | null;
  noteType: NoteType | undefined;
  onSave: (note: Note, fields: Record<string, string>, tags: string[]) => void;
  onClose: () => void;
}

/**
 * Native modal `<dialog>` note editor following modern-web-guidance `dialog` best practices:
 * - Opened via `showModal()` (top-layer, inert background, Esc/back dismiss, focus return)
 * - No redundant `role="dialog"` or `aria-modal`
 * - Uses `closedby="any"` with pointer-position light-dismiss fallback when unsupported
 */
export function NoteEditDialog({ note, noteType, onSave, onClose }: NoteEditDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const closedByCodeRef = useRef(false);
  const [draftFields, setDraftFields] = useState<Record<string, string>>({});
  const [tagsText, setTagsText] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (note) {
      closedByCodeRef.current = false;
      setDraftFields({ ...note.fields });
      setTagsText(note.tags.join(', '));
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      closedByCodeRef.current = true;
      dialog.close();
    }
  }, [note]);

  const closeDialog = (returnVal: string) => {
    closedByCodeRef.current = true;
    const dialog = dialogRef.current;
    if (dialog && dialog.open) {
      dialog.close(returnVal);
    }
    onClose();
  };

  // Fallback light-dismiss for browsers without native `dialog.closedBy`
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      if (closedByCodeRef.current) {
        closedByCodeRef.current = false;
        return;
      }
      onClose();
    };
    dialog.addEventListener('close', handleClose);

    if ('closedBy' in HTMLDialogElement.prototype) {
      return () => {
        dialog.removeEventListener('close', handleClose);
      };
    }

    const isOutside = (e: PointerEvent): boolean => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);
    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, [onClose]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!note) return;
    const parsedTags = tagsText
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    onSave(note, draftFields, parsedTags);
    closeDialog('save');
  };

  const fieldsList =
    noteType?.fields ??
    Object.keys(draftFields).map((key) => ({
      key,
      label: key,
      kind: 'text' as const,
      lang: 'en',
    }));

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: 'any' } as Record<string, string>)}
      className="flash-dialog m-auto w-[min(92vw,34rem)] rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--fg)] shadow-2xl"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 id={titleId} className="text-lg font-semibold">
            Edit Note
          </h2>
          <button
            type="button"
            onClick={() => closeDialog('cancel')}
            aria-label="Close dialog"
            className="rounded-lg px-2.5 py-1 text-sm text-[var(--muted)] hover:bg-[var(--surface-2)]"
          >
            ✕
          </button>
        </div>

        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
          {fieldsList.map((field, index) => {
            const isMultiline =
              field.kind === 'rich' || field.key === 'notes' || field.key === 'example';
            const value = draftFields[field.key] ?? '';
            return (
              <label key={field.key} className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-[var(--muted)]">
                  {field.label} <span className="text-xs opacity-70">({field.lang})</span>
                </span>
                {isMultiline ? (
                  <textarea
                    lang={field.lang}
                    rows={2}
                    autoFocus={index === 0}
                    value={value}
                    onChange={(e) =>
                      setDraftFields((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
                  />
                ) : (
                  <input
                    type="text"
                    lang={field.lang}
                    autoFocus={index === 0}
                    value={value}
                    onChange={(e) =>
                      setDraftFields((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
                  />
                )}
              </label>
            );
          })}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-[var(--muted)]">Tags (comma-separated)</span>
            <input
              type="text"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="topik-1, verbs"
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => closeDialog('cancel')}
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium hover:bg-[var(--surface-2)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
