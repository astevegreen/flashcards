import {
  planStudySetTagRewrites,
  planTagOperation,
  summarizeTags,
  TAG_HIERARCHY_SEPARATOR,
  type KnownEvent,
  type TagOperation,
  type TagOperationError,
} from '@flash/core';
import { lazy, Suspense, useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { readTagsGuideDismissed, storeTagsGuideDismissed } from './tagsGuide.ts';

const LazyTagsGuidePanel = lazy(() =>
  import('./TagsGuidePanel.tsx').then((m) => ({ default: m.TagsGuidePanel })),
);

/** Stable callback ref: focuses the rename input once, when it mounts. */
const focusOnMount = (el: HTMLInputElement | null) => el?.focus();

export interface TagManagerPanelProps {
  onClose: () => void;
}

function describeError(error: TagOperationError): string {
  switch (error.code) {
    case 'invalid_name':
      return error.problem === 'empty'
        ? 'Enter a category name.'
        : error.problem === 'separator_char'
          ? 'Category names cannot contain "," or ";" (CSV files use them to separate categories).'
          : 'Each part of a "::" category needs a name.';
    case 'no_source':
      return 'Choose at least one category.';
    case 'target_overlaps_source':
      return `"${error.source}" and the new name are in the same "::" branch. Pick a name outside it.`;
  }
}

const studySetsText = (n: number) => `${n} study set${n === 1 ? '' : 's'}`;

const inputClass =
  'min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm';
const buttonClass =
  'shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:opacity-90 disabled:opacity-40';

/**
 * Collection-wide category manager (Phase 9), lazily loaded from Browse. Each rename, merge or
 * delete is planned by `planTagOperation` in core and appended as ONE batch of tag-only
 * `NoteUpserted` events. Tags render as plain text (§13).
 */
export function TagManagerPanel({ onClose }: TagManagerPanelProps) {
  const { state, stateVersion, emitEvents, getEventFactory } = useApp();
  const summary = useMemo(
    () => summarizeTags(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [mergeSelection, setMergeSelection] = useState<ReadonlySet<string>>(new Set());
  const [mergeTarget, setMergeTarget] = useState('');
  // Open by default until the reader dismisses it once on this device.
  const [showGuide, setShowGuide] = useState(() => !readTagsGuideDismissed());
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const labelOf = (key: string) => summary.tags.find((t) => t.key === key)?.label ?? key;

  const run = (op: TagOperation, done: (notes: number) => string): boolean => {
    const plan = planTagOperation(state, op);
    if (plan.error) {
      setMessage({ kind: 'error', text: describeError(plan.error) });
      return false;
    }
    // Saved Study Sets that reference the category follow it, in the same batch.
    const setPayloads = planStudySetTagRewrites(state, op);
    const factory = getEventFactory();
    const nowMs = Date.now();
    const events: KnownEvent[] = plan.payloads.map((p) => factory.create('NoteUpserted', p, nowMs));
    for (const p of setPayloads) events.push(factory.create('StudySetSaved', p, nowMs));
    emitEvents(events);
    const setsText = setPayloads.length > 0 ? ` Updated ${studySetsText(setPayloads.length)}.` : '';
    setMessage({ kind: 'ok', text: done(plan.payloads.length) + setsText });
    return true;
  };

  const notesText = (n: number) => `${n} note${n === 1 ? '' : 's'}`;

  const submitRename = (e: FormEvent, key: string) => {
    e.preventDefault();
    const from = labelOf(key);
    if (
      run(
        { kind: 'rename', from: key, to: renameText },
        (n) => `Renamed "${from}" to "${renameText.trim()}" on ${notesText(n)}.`,
      )
    ) {
      setRenaming(null);
      setMergeSelection(new Set());
    }
  };

  const submitMerge = (e: FormEvent) => {
    e.preventDefault();
    const from = [...mergeSelection];
    if (
      run(
        { kind: 'merge', from, into: mergeTarget },
        (n) => `Merged ${from.length} categories into "${mergeTarget.trim()}" on ${notesText(n)}.`,
      )
    ) {
      setMergeSelection(new Set());
      setMergeTarget('');
    }
  };

  const toggleMerge = (key: string) => {
    const next = new Set(mergeSelection);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setMergeSelection(next);
  };

  return (
    <div
      role="region"
      aria-label="Manage categories"
      data-testid="tag-manager"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-bold">
          Manage categories{' '}
          <span className="text-sm font-normal text-[var(--muted)]">({summary.tags.length})</span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="tag-manager-guide"
            aria-expanded={showGuide}
            onClick={() => setShowGuide((v) => !v)}
            className={buttonClass}
          >
            How tags work
          </button>
          <button
            type="button"
            data-testid="tag-manager-close"
            onClick={onClose}
            className={buttonClass}
          >
            Done
          </button>
        </div>
      </div>
      {showGuide && (
        <Suspense fallback={null}>
          <LazyTagsGuidePanel
            onDismiss={() => {
              storeTagsGuideDismissed(true);
              setShowGuide(false);
            }}
          />
        </Suspense>
      )}
      <p className="text-xs text-[var(--muted)]">
        Changes apply to every note in the collection and to saved study sets. Renaming or deleting
        a category also changes its <code>::</code> subcategories.
      </p>

      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          data-testid="tag-manager-message"
          className={`text-xs ${message.kind === 'error' ? 'text-rose-600 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300'}`}
        >
          {message.text}
        </p>
      )}

      {summary.unnormalizedNoteCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <span>
            {notesText(summary.unnormalizedNoteCount)} store a category in a different form (for
            example Hangul typed on a Mac).
          </span>
          <button
            type="button"
            data-testid="tag-manager-normalize"
            className={buttonClass}
            onClick={() =>
              run({ kind: 'normalize' }, (n) => `Cleaned up categories on ${notesText(n)}.`)
            }
          >
            Clean up
          </button>
        </div>
      )}

      {mergeSelection.size >= 2 && (
        <form
          onSubmit={submitMerge}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2"
        >
          <span className="text-xs font-semibold">Merge {mergeSelection.size} into</span>
          <input
            aria-label="Merged category name"
            data-testid="tag-manager-merge-input"
            list="tag-manager-merge-options"
            value={mergeTarget}
            onChange={(e) => setMergeTarget(e.target.value)}
            className={inputClass}
          />
          <datalist id="tag-manager-merge-options">
            {[...mergeSelection].map((k) => (
              <option key={k} value={labelOf(k)} />
            ))}
          </datalist>
          <button type="submit" data-testid="tag-manager-merge-submit" className={buttonClass}>
            Merge
          </button>
        </form>
      )}

      {summary.tags.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          No categories yet. Add them to notes in Browse.
        </p>
      ) : (
        <ul className="flex max-h-[50dvh] flex-col overflow-y-auto" data-testid="tag-manager-list">
          {summary.tags.map((tag) => {
            const segments = tag.label.split(TAG_HIERARCHY_SEPARATOR);
            const leaf = segments[segments.length - 1] ?? tag.label;
            return (
              <li
                key={tag.key}
                data-testid={`tag-row-${tag.key}`}
                className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] py-1.5 last:border-b-0"
                style={{ paddingLeft: `${tag.depth * 1.25}rem` }}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${tag.label} to merge`}
                  data-testid={`tag-merge-${tag.key}`}
                  checked={mergeSelection.has(tag.key)}
                  onChange={() => toggleMerge(tag.key)}
                />
                {renaming === tag.key ? (
                  <form
                    onSubmit={(e) => submitRename(e, tag.key)}
                    className="flex flex-1 items-center gap-2"
                  >
                    <input
                      ref={focusOnMount}
                      aria-label={`New name for ${tag.label}`}
                      data-testid="tag-rename-input"
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      className={inputClass}
                    />
                    <button type="submit" data-testid="tag-rename-submit" className={buttonClass}>
                      Save
                    </button>
                    <button type="button" onClick={() => setRenaming(null)} className={buttonClass}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm" title={tag.label}>
                      {tag.depth > 0 && <span className="text-[var(--muted)]">↳ </span>}#{leaf}
                    </span>
                    <span
                      data-testid={`tag-count-${tag.key}`}
                      className="tabular-nums text-xs text-[var(--muted)]"
                      title={`${tag.directNoteCount} tagged directly`}
                    >
                      {tag.noteCount}
                    </span>
                    {tag.archivedNoteCount > 0 && (
                      <span
                        data-testid={`tag-archived-count-${tag.key}`}
                        className="text-xs text-[var(--muted)]"
                      >
                        +{tag.archivedNoteCount} archived
                      </span>
                    )}
                    <button
                      type="button"
                      data-testid={`tag-rename-${tag.key}`}
                      className={buttonClass}
                      onClick={() => {
                        setRenaming(tag.key);
                        setRenameText(tag.label);
                        setConfirmDelete(null);
                      }}
                    >
                      Rename
                    </button>
                    {confirmDelete === tag.key ? (
                      <button
                        type="button"
                        data-testid={`tag-delete-confirm-${tag.key}`}
                        className={`${buttonClass} border-rose-500/50 text-rose-700 dark:text-rose-300`}
                        onClick={() => {
                          run(
                            { kind: 'delete', tags: [tag.key] },
                            (n) => `Removed "${tag.label}" from ${notesText(n)}.`,
                          );
                          setConfirmDelete(null);
                          setMergeSelection(new Set());
                        }}
                      >
                        Remove from {notesText(tag.noteCount + tag.archivedNoteCount)}?
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`tag-delete-${tag.key}`}
                        className={buttonClass}
                        onClick={() => setConfirmDelete(tag.key)}
                      >
                        Delete
                      </button>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
