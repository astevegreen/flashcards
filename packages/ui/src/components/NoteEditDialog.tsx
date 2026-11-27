import {
  hasRichText,
  stripCloze,
  toggleRichTextMark,
  type Note,
  type NoteType,
  type RichTextMark,
  type SourceRef,
} from '@flash/core';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useApp } from '../state/AppContext.tsx';
import { MediaAudioPlayer } from './MediaAudioPlayer.tsx';
import { MediaImage } from './MediaImage.tsx';
import { RichText } from './RichText.tsx';
import { RichTextToolbar } from './RichTextToolbar.tsx';
import {
  DISCARD_NOTE_EDITS_PROMPT,
  hasNoteEditChanges,
  noteEditChanges,
  type NoteEditSnapshot,
} from './noteEditDiff.ts';

/**
 * Largest pasted or dropped image read into memory. Mirrors the 20 MiB input cap that
 * `processImage` enforces, so a huge clipboard file is refused before it is read.
 */
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

/** The first image file in a paste or drop, or `null` when it carries no file at all. */
function firstImageFile(data: DataTransfer | null): { file: File | null; hasFiles: boolean } {
  if (!data) return { file: null, hasFiles: false };
  const files = Array.from(data.files);
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
  const all = files.length > 0 ? files : fromItems;
  return {
    // An empty type (some drags from file managers) goes on to `processImage`, which sniffs bytes.
    file: all.find((f) => f.type === '' || f.type.startsWith('image/')) ?? null,
    hasFiles: all.length > 0,
  };
}

export interface NoteEditDialogProps {
  note: Note | null;
  noteType: NoteType | undefined;
  deckSource?: SourceRef | undefined;
  /** Receives only the fields that changed and, when the tag text was edited, the new tags (D7). */
  onSave: (note: Note, fields: Record<string, string>, tags: string[] | undefined) => void;
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
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The note the drafts were last filled from, and its fields and tags at that moment.
  const [opened, setOpened] = useState<{ note: Note | null; snapshot: NoteEditSnapshot }>({
    note: null,
    snapshot: { fields: {}, tagsText: '' },
  });
  // A new note fills the drafts in the same render, before the dialog shows.
  if (opened.note !== note) {
    const snapshot = note
      ? { fields: { ...note.fields }, tagsText: note.tags.join(', ') }
      : opened.snapshot;
    setOpened({ note, snapshot });
    if (note) {
      setDraftFields({ ...snapshot.fields });
      setTagsText(snapshot.tagsText);
      setUploadError(null);
    }
  }
  const dirty = hasNoteEditChanges(opened.snapshot, draftFields, tagsText);
  // Read by the light-dismiss listener, which outlives a render.
  const dirtyRef = useRef(false);
  useLayoutEffect(() => {
    dirtyRef.current = dirty;
  });
  const [uploadingField, setUploadingField] = useState<string | null>(null);
  // Synchronous twin of `uploadingField`: two pastes in one tick both see stale state.
  const uploadingRef = useRef(false);
  const [activeTextField, setActiveTextField] = useState<string | null>(null);
  const [styleHint, setStyleHint] = useState<{ field: string; text: string } | null>(null);
  const textFieldRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});
  const pendingSelectionRef = useRef<{ field: string; start: number; end: number } | null>(null);

  // Restores the selection after a toolbar or shortcut edit re-renders the field.
  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    pendingSelectionRef.current = null;
    const el = textFieldRefs.current[pending.field];
    if (el) {
      el.focus();
      el.setSelectionRange(pending.start, pending.end);
    }
  }, [draftFields]);

  /** Bold / italic / colour for the field's selection; markup goes into the plain string. */
  const applyMark = (fieldKey: string, mark: RichTextMark) => {
    const el = textFieldRefs.current[fieldKey];
    if (!el) return;
    const current = el.value;
    const edit = toggleRichTextMark(
      current,
      el.selectionStart ?? current.length,
      el.selectionEnd ?? current.length,
      mark,
    );
    if (!edit) {
      setStyleHint({
        field: fieldKey,
        text: "Can't style there. Select text outside ruby {…|…}, a [reading] or cloze {{c1::…}} brackets, or the whole group. Inside a cloze, stay on one side of ::.",
      });
      return;
    }
    setStyleHint(null);
    pendingSelectionRef.current = {
      field: fieldKey,
      start: edit.selectionStart,
      end: edit.selectionEnd,
    };
    setDraftFields((prev) => ({ ...prev, [fieldKey]: edit.text }));
  };

  const handleStyleShortcut = (
    fieldKey: string,
    e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key !== 'b' && key !== 'i') return;
    e.preventDefault();
    applyMark(fieldKey, key);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (note) {
      closedByCodeRef.current = false;
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
        if (!dirtyRef.current || window.confirm(DISCARD_NOTE_EDITS_PROMPT)) dialog.close();
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

  /** The one path every image takes: validate + resize (`processImage`), store, then reference. */
  const storeImage = async (
    fieldKey: string,
    readBytes: () => Promise<{ bytes: Uint8Array; mime: string } | null>,
  ) => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    setUploadError(null);
    setUploadingField(fieldKey);
    try {
      const picked = await readBytes();
      if (!picked) return;
      if (!platform.processImage) {
        throw new Error('Image processing is unavailable on this platform.');
      }
      const processed = await platform.processImage(picked.bytes, picked.mime);
      await addMedia(processed);
      setDraftFields((prev) => ({ ...prev, [fieldKey]: `media:${processed.hash}` }));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      uploadingRef.current = false;
      setUploadingField(null);
    }
  };

  const handleUploadImage = (fieldKey: string) =>
    storeImage(fieldKey, async () => {
      const picked = await platform.files.pickFile({
        accept: 'image/png,image/jpeg,image/webp,image/gif',
      });
      return picked ? { bytes: picked.bytes, mime: picked.mime ?? '' } : null;
    });

  /** Pasted or dropped image file: same checks as the picker, plus a size cap before reading. */
  const handleImageFile = (fieldKey: string, file: File) =>
    storeImage(fieldKey, async () => {
      if (file.size > MAX_IMAGE_INPUT_BYTES) {
        throw new Error(
          `Image exceeds maximum input size (${Math.round(MAX_IMAGE_INPUT_BYTES / (1024 * 1024))} MiB).`,
        );
      }
      return { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type };
    });

  const imageFieldKeys = (noteType?.fields ?? [])
    .filter((f) => f.kind === 'image')
    .map((f) => f.key);

  /**
   * Paste or drop on an image field's drop zone goes to that field. Anywhere else in the dialog,
   * an image (with no text alongside it) goes to the note's only image field, if it has exactly
   * one; otherwise the event is left alone, apart from stopping a dropped file from opening.
   */
  const routeImageTransfer = (
    e: ClipboardEvent<HTMLElement> | DragEvent<HTMLElement>,
    data: DataTransfer | null,
  ) => {
    const { file, hasFiles } = firstImageFile(data);
    if (!hasFiles) return;
    const isDrop = e.type === 'drop';
    // A drop on the backdrop (the <dialog> itself) is ignored, but never opens the file.
    if (isDrop && e.target === e.currentTarget) {
      e.preventDefault();
      return;
    }
    const zone = (e.target as HTMLElement | null)?.closest?.('[data-image-drop-field]');
    const zoneKey = zone?.getAttribute('data-image-drop-field') ?? null;
    if (zoneKey) {
      e.preventDefault();
      // One image at a time: a transfer while one is processing is dropped, not raced.
      if (uploadingRef.current) return;
      if (file) void handleImageFile(zoneKey, file);
      else setUploadError('Only PNG, JPEG, WebP, or GIF images can be added here.');
      return;
    }
    if (isDrop) e.preventDefault();
    const hasText = (data?.getData('text/plain') ?? '').length > 0;
    const onlyImageField = imageFieldKeys.length === 1 ? imageFieldKeys[0] : undefined;
    if (!file || hasText || onlyImageField === undefined) return;
    e.preventDefault();
    if (uploadingRef.current) return;
    void handleImageFile(onlyImageField, file);
  };

  const handleUploadAudio = async (fieldKey: string) => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
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
      uploadingRef.current = false;
      setUploadingField(null);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Saving mid-upload would drop the image and orphan the blob `addMedia` is writing.
    if (!note || uploadingField !== null) return;
    const changes = noteEditChanges(opened.snapshot, draftFields, tagsText);
    onSave(note, changes.fields, changes.tags);
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
      onCancel={(e) => {
        // Escape, or a click outside with native closedby: unsaved edits are never lost silently.
        if (!dirty) return;
        e.preventDefault();
        if (window.confirm(DISCARD_NOTE_EDITS_PROMPT)) closeDialog('cancel');
      }}
      onPaste={(e) => routeImageTransfer(e, e.clipboardData)}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => routeImageTransfer(e, e.dataTransfer)}
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
                  <div
                    tabIndex={0}
                    role="group"
                    aria-label={`${field.label}: paste or drop an image here`}
                    data-image-drop-field={field.key}
                    data-testid={`image-drop-${field.key}`}
                    className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg)] p-2 focus:border-[var(--accent)] focus:outline-none"
                  >
                    {value ? (
                      <MediaImage src={value} alt={field.label} className="max-h-40" />
                    ) : (
                      <span className="text-xs text-[var(--muted)]">
                        {busy ? 'Processing…' : 'Paste or drop an image here'}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`upload-image-${field.key}`}
                      disabled={uploadingField !== null}
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
                      disabled={uploadingField !== null}
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
            const textProps = {
              lang: field.lang,
              autoFocus: index === 0,
              value,
              'data-testid': `field-input-${field.key}`,
              ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
                textFieldRefs.current[field.key] = el;
              },
              onFocus: () => setActiveTextField(field.key),
              onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                handleStyleShortcut(field.key, e),
              onChange: (e: { target: { value: string } }) =>
                setDraftFields((prev) => ({ ...prev, [field.key]: e.target.value })),
              className:
                'rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none',
            };
            const showPreview = hasRichText(value);
            return (
              <div key={field.key} className="flex flex-col gap-1 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="font-medium text-[var(--muted)]">
                    {field.label} <span className="text-xs opacity-70">({field.lang})</span>
                  </span>
                  {isMultiline ? (
                    <textarea rows={2} {...textProps} />
                  ) : (
                    <input type="text" {...textProps} />
                  )}
                </label>
                {activeTextField === field.key && (
                  <RichTextToolbar
                    fieldKey={field.key}
                    onApply={(mark) => applyMark(field.key, mark)}
                  />
                )}
                {styleHint?.field === field.key && (
                  <span role="status" className="text-[11px] text-[var(--muted)]">
                    {styleHint.text}
                  </span>
                )}
                {showPreview && (
                  <div
                    data-testid={`field-preview-${field.key}`}
                    className="whitespace-pre-wrap rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-sm"
                  >
                    <span className="sr-only">Preview: </span>
                    {/* Cloze answers shown in place, so `{{c1::{b:x}}}` previews bold. */}
                    <RichText text={stripCloze(value)} lang={field.lang} />
                  </div>
                )}
              </div>
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
              disabled={uploadingField !== null}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
