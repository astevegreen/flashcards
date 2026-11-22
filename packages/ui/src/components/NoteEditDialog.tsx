import type { Note, NoteType, SourceRef } from '@flash/core';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { MediaAudioPlayer } from './MediaAudioPlayer.tsx';
import { MediaImage } from './MediaImage.tsx';

export interface NoteEditDialogProps {
  note: Note | null;
  noteType: NoteType | undefined;
  deckSource?: SourceRef | undefined;
  onSave: (note: Note, fields: Record<string, string>, tags: string[]) => void;
  onClose: () => void;
}

/**
 * Native modal `<dialog>` note editor following modern-web-guidance `dialog` best practices:
 * - Opened via `showModal()` (top-layer, inert background, Esc/back dismiss, focus return)
 * - No redundant `role="dialog"` or `aria-modal`
 * - Uses `closedby="any"` with pointer-position light-dismiss fallback when unsupported
 */
export function NoteEditDialog({
  note,
  noteType,
  deckSource,
  onSave,
  onClose,
}: NoteEditDialogProps) {
  const { platform, addMedia, setNoteArchived } = useApp();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const closedByCodeRef = useRef(false);
  const [draftFields, setDraftFields] = useState<Record<string, string>>({});
  const [tagsText, setTagsText] = useState('');
  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (note) {
      closedByCodeRef.current = false;
      setDraftFields({ ...note.fields });
      setTagsText(note.tags.join(', '));
      setUploadError(null);
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

  const handleUploadImage = async (fieldKey: string) => {
    setUploadError(null);
    setUploadingField(fieldKey);
    try {
      const picked = await platform.files.pickFile({
        accept: 'image/png,image/jpeg,image/webp,image/gif',
      });
      if (!picked) return;
      if (!platform.processImage) {
        throw new Error('Image processing is unavailable on this platform.');
      }
      const processed = await platform.processImage(picked.bytes, picked.mime ?? '');
      await addMedia(processed);
      setDraftFields((prev) => ({ ...prev, [fieldKey]: `media:${processed.hash}` }));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingField(null);
    }
  };

  const handleUploadAudio = async (fieldKey: string) => {
    setUploadError(null);
    setUploadingField(fieldKey);
    try {
      const picked = await platform.files.pickFile({
        accept: 'audio/mpeg,audio/wav,audio/ogg,audio/mp4,.mp3,.wav,.ogg,.m4a',
      });
      if (!picked) return;
      if (!platform.processAudio) {
        throw new Error('Audio processing is unavailable on this platform.');
      }
      const processed = await platform.processAudio(picked.bytes, picked.mime ?? '');
      await addMedia(processed);
      setDraftFields((prev) => ({ ...prev, [fieldKey]: `media:${processed.hash}` }));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingField(null);
    }
  };

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
    Object.keys(draftFields)
      .filter((key) => key !== 'speech_override')
      .map((key) => ({
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

        {deckSource?.kind === 'google_sheets' &&
          deckSource.uri?.startsWith('https://docs.google.com/spreadsheets/') && (
            <div
              data-testid="sheet-source-edit-banner"
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs"
            >
              <span className="text-[var(--muted)]">
                Synced from a Google Sheet. Edit in Sheets to keep changes on the next pull, or edit
                locally offline below.
              </span>
              <a
                href={deckSource.uri}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="open-source-sheet-link"
                className="rounded-lg bg-[var(--accent)] px-2.5 py-1 font-semibold text-white hover:opacity-90"
              >
                Open in Google Sheets ↗
              </a>
            </div>
          )}

        {uploadError && (
          <div
            role="alert"
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
          >
            {uploadError}
          </div>
        )}

        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
          {fieldsList.map((field, index) => {
            const value = draftFields[field.key] ?? '';

            if (field.kind === 'image') {
              const busy = uploadingField === field.key;
              return (
                <div key={field.key} className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-[var(--muted)]">{field.label}</span>
                  {value && (
                    <div className="flex flex-col items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-2">
                      <MediaImage src={value} alt={field.label} className="max-h-40" />
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`upload-image-${field.key}`}
                      disabled={busy}
                      onClick={() => void handleUploadImage(field.key)}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? 'Processing…' : value ? 'Replace Image' : 'Upload Image'}
                    </button>
                    {value && (
                      <button
                        type="button"
                        data-testid={`remove-image-${field.key}`}
                        onClick={() => setDraftFields((prev) => ({ ...prev, [field.key]: '' }))}
                        className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            }

            if (field.kind === 'audio') {
              const busy = uploadingField === field.key;
              return (
                <div key={field.key} className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-[var(--muted)]">{field.label}</span>
                  {value && <MediaAudioPlayer src={value} label={field.label} />}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`upload-audio-${field.key}`}
                      disabled={busy}
                      onClick={() => void handleUploadAudio(field.key)}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? 'Validating…' : value ? 'Replace Audio' : 'Upload Audio'}
                    </button>
                    {value && (
                      <button
                        type="button"
                        data-testid={`remove-audio-${field.key}`}
                        onClick={() => setDraftFields((prev) => ({ ...prev, [field.key]: '' }))}
                        className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            }

            const isMultiline =
              field.kind === 'rich' || field.key === 'notes' || field.key === 'example';
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
            <span className="font-medium text-[var(--muted)]">
              Pronunciation override (TTS text)
            </span>
            <input
              type="text"
              data-testid="speech-override-input"
              value={draftFields['speech_override'] ?? ''}
              onChange={(e) =>
                setDraftFields((prev) => ({ ...prev, speech_override: e.target.value }))
              }
              placeholder="Optional kana / hangul reading for TTS (e.g. はし or 한국어)"
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
            />
            <span className="text-[11px] text-[var(--muted)]">
              Overrides which text is spoken by TTS (useful for Japanese Kanji or Korean Hanja
              disambiguation). Leave blank to use the layout&apos;s default speak field.
            </span>
          </label>

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

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <div>
            {note && (
              <button
                type="button"
                data-testid="archive-note-btn"
                onClick={() => {
                  setNoteArchived(note.id, !note.archived);
                  closeDialog(note.archived ? 'restore' : 'archive');
                }}
                className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-500/20 dark:text-rose-400"
              >
                {note.archived ? 'Restore Note' : 'Archive Note'}
              </button>
            )}
          </div>
          <div className="flex gap-2">
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
        </div>
      </form>
    </dialog>
  );
}
