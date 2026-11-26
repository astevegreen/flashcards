import {
  compareCodeUnits,
  createBulkEvents,
  encodeUtf8,
  listMoveTargetDecks,
  normalizeTagText,
  planBulkNoteAction,
  tagKey,
  type BulkActionError,
  type BulkNoteAction,
} from '@flash/core';
import { Suspense, useMemo, useState, type FormEvent } from 'react';
import { exportAnkiCsvZip } from '../export/ankiExport.ts';
import { isExportCancelled } from '../export/exportCancelled.ts';
import { lazyWithRetry } from '../lazy/lazyWithRetry.tsx';
import { useApp } from '../state/AppContext.tsx';

const LazyFindReplacePanel = lazyWithRetry(
  () => import('./FindReplacePanel.tsx').then((m) => ({ default: m.FindReplacePanel })),
  { closeWith: 'onClose' },
);

export interface BulkEditBarProps {
  /** Selected note ids (already limited to the visible list). */
  noteIds: readonly string[];
  /** True while Browse shows archived notes (offers Restore instead of Archive). */
  showingArchived: boolean;
  onClear: () => void;
}

function describeError(error: BulkActionError): string {
  switch (error.code) {
    case 'invalid_tag':
      return `"${error.tag}" is not a valid tag name (no "," or ";", no empty "::" parts).`;
    case 'unknown_deck':
      return 'Choose a deck to move the notes to.';
    case 'note_type_mismatch':
      return 'Notes can only move to a deck with the same note type.';
    case 'source_linked':
      return 'Notes in a deck linked to a Sheet, folder or package cannot be moved (the next sync would move them back).';
    case 'source_key_conflict':
      return `${error.noteIds.length} selected note(s) share a Card ID with a note already in that deck (or with each other), so they were not moved.`;
  }
}

const buttonClass =
  'rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:opacity-90 disabled:opacity-40';
const inputClass =
  'min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs';

/**
 * Browse bulk edit bar (Phase 9), lazily loaded once something is selected. Every action is
 * planned in core (`planBulkNoteAction`) and appended as ONE batch of events.
 */
export function BulkEditBar({ noteIds, showingArchived, onClear }: BulkEditBarProps) {
  const { state, stateVersion, emitEvents, getEventFactory, platform } = useApp();
  const [addText, setAddText] = useState('');
  const [removeTag, setRemoveTag] = useState('');
  const [moveDeckId, setMoveDeckId] = useState('');
  const [forAnki, setForAnki] = useState(false);
  const [forOtherApps, setForOtherApps] = useState(false);
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const info = useMemo(() => {
    const tags = new Map<string, string>();
    const deckIds = new Set<string>();
    const noteTypeIds = new Set<string>();
    for (const id of noteIds) {
      const note = state.notes.get(id);
      if (!note) continue;
      deckIds.add(note.deck_id);
      const nt = state.decks.get(note.deck_id)?.note_type_id;
      if (nt) noteTypeIds.add(nt);
      for (const t of note.tags) {
        const key = tagKey(t);
        if (key && !tags.has(key)) tags.set(key, normalizeTagText(t));
      }
    }
    const [onlyNoteType] = noteTypeIds.size === 1 ? [...noteTypeIds] : [];
    const moveTargets = onlyNoteType
      ? listMoveTargetDecks(state, onlyNoteType)
          .map((id) => state.decks.get(id))
          .filter((d) => d !== undefined)
          .sort((a, b) => compareCodeUnits(a.name, b.name))
      : [];
    const [onlyDeck] = deckIds.size === 1 ? [...deckIds] : [];
    return {
      tags: [...tags.entries()].sort((a, b) => compareCodeUnits(a[0], b[0])),
      moveTargets,
      onlyDeck,
      mixedNoteTypes: noteTypeIds.size > 1,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, noteIds]);

  const notesText = (n: number) => `${n} note${n === 1 ? '' : 's'}`;

  const run = (action: BulkNoteAction, verb: string) => {
    const plan = planBulkNoteAction(state, noteIds, action);
    if (plan.error) {
      setMessage({ kind: 'error', text: describeError(plan.error) });
      return false;
    }
    emitEvents(createBulkEvents(getEventFactory(), plan.events, Date.now()));
    setMessage({ kind: 'ok', text: `${verb} ${notesText(plan.changedNoteCount)}.` });
    return true;
  };

  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    const tags = addText
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tags.length === 0) return;
    if (run({ kind: 'add_tags', tags }, `Added ${tags.map((t) => `"${t}"`).join(', ')} to`)) {
      setAddText('');
    }
  };

  const exportCsvFile = async () => {
    if (!info.onlyDeck) return;
    if (forAnki) {
      try {
        const text = await exportAnkiCsvZip(platform, state, {
          deckId: info.onlyDeck,
          noteIds,
          includeArchived: showingArchived,
        });
        setMessage({ kind: 'ok', text });
      } catch (err) {
        setMessage(
          isExportCancelled(err)
            ? { kind: 'ok', text: 'Export cancelled.' }
            : { kind: 'error', text: err instanceof Error ? err.message : String(err) },
        );
      }
      return;
    }
    const deck = state.decks.get(info.onlyDeck);
    const { exportCsv } = await import('@flash/core/csv');
    const result = exportCsv(state, {
      deckId: info.onlyDeck,
      noteIds,
      includeArchived: showingArchived,
      ...(forOtherApps ? { stripRichText: true } : {}),
    });
    const slug =
      (deck?.name ?? 'deck')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'deck';
    try {
      await platform.files.downloadFile(`${slug}.csv`, encodeUtf8(result.text), 'text/csv');
      setMessage({ kind: 'ok', text: `Exported ${notesText(result.noteCount)} to ${slug}.csv.` });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div
      role="region"
      aria-label="Bulk edit selected notes"
      data-testid="bulk-edit-bar"
      className="flex flex-col gap-2 rounded-2xl border border-[var(--accent)] bg-[var(--accent-soft)] p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="bulk-selected-count" className="text-sm font-semibold">
          {notesText(noteIds.length)} selected
        </span>
        <button type="button" data-testid="bulk-clear" onClick={onClear} className={buttonClass}>
          Clear selection
        </button>
        <span className="flex-1" />
        {showingArchived ? (
          <button
            type="button"
            data-testid="bulk-restore"
            className={buttonClass}
            onClick={() => run({ kind: 'restore' }, 'Restored')}
          >
            Restore
          </button>
        ) : (
          <>
            <button
              type="button"
              data-testid="bulk-suspend"
              className={buttonClass}
              onClick={() => run({ kind: 'suspend' }, 'Suspended')}
            >
              Suspend
            </button>
            <button
              type="button"
              data-testid="bulk-unsuspend"
              className={buttonClass}
              onClick={() => run({ kind: 'unsuspend' }, 'Unsuspended')}
            >
              Unsuspend
            </button>
            <button
              type="button"
              data-testid="bulk-archive"
              className={buttonClass}
              onClick={() => run({ kind: 'archive' }, 'Archived')}
            >
              Archive
            </button>
          </>
        )}
        <button
          type="button"
          data-testid="bulk-export-csv"
          className={buttonClass}
          disabled={!info.onlyDeck}
          title={info.onlyDeck ? 'Export as CSV' : 'Select notes from one deck to export CSV'}
          onClick={() => void exportCsvFile()}
        >
          Export CSV
        </button>
        <label
          className="flex items-center gap-1 text-xs"
          title="Adds Anki's import headers and zips the CSV with its media"
        >
          <input
            type="checkbox"
            data-testid="bulk-export-for-anki"
            checked={forAnki}
            onChange={(e) => {
              setForAnki(e.target.checked);
              if (e.target.checked) setForOtherApps(false);
            }}
          />
          For Anki
        </label>
        <label
          className="flex items-center gap-1 text-xs"
          title="Plain text for Excel, Sheets or Numbers: drops formatting marks and stops cells running as formulas"
        >
          <input
            type="checkbox"
            data-testid="bulk-export-for-other-apps"
            checked={forOtherApps}
            onChange={(e) => {
              setForOtherApps(e.target.checked);
              if (e.target.checked) setForAnki(false);
            }}
          />
          For other apps
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={submitAdd} className="flex items-center gap-1.5">
          <input
            aria-label="Tags to add"
            data-testid="bulk-add-tags-input"
            placeholder="Add tags…"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            className={`${inputClass} w-40`}
          />
          <button
            type="submit"
            data-testid="bulk-add-tags-submit"
            disabled={!addText.trim()}
            className={buttonClass}
          >
            Add
          </button>
        </form>

        <div className="flex items-center gap-1.5">
          <select
            aria-label="Tag to remove"
            data-testid="bulk-remove-tag-select"
            value={removeTag}
            onChange={(e) => setRemoveTag(e.target.value)}
            className={inputClass}
          >
            <option value="">Remove tag…</option>
            {info.tags.map(([key, label]) => (
              <option key={key} value={key}>
                #{label}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="bulk-remove-tag-submit"
            disabled={!removeTag}
            className={buttonClass}
            onClick={() => {
              if (run({ kind: 'remove_tags', tags: [removeTag] }, `Removed "${removeTag}" from`)) {
                setRemoveTag('');
              }
            }}
          >
            Remove
          </button>
        </div>

        <button
          type="button"
          data-testid="bulk-find-replace"
          aria-expanded={showFindReplace}
          className={buttonClass}
          onClick={() => setShowFindReplace((v) => !v)}
        >
          Find and replace…
        </button>

        {!showingArchived && (
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Move to deck"
              data-testid="bulk-move-deck-select"
              value={moveDeckId}
              disabled={info.moveTargets.length === 0}
              title={
                info.mixedNoteTypes
                  ? 'Selected notes use different note types'
                  : 'Decks with the same note type'
              }
              onChange={(e) => setMoveDeckId(e.target.value)}
              className={inputClass}
            >
              <option value="">Move to deck…</option>
              {info.moveTargets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="bulk-move-deck-submit"
              disabled={!moveDeckId}
              className={buttonClass}
              onClick={() => {
                const name = state.decks.get(moveDeckId)?.name ?? 'deck';
                if (run({ kind: 'move_deck', deckId: moveDeckId }, `Moved to "${name}":`)) {
                  setMoveDeckId('');
                }
              }}
            >
              Move
            </button>
          </div>
        )}
      </div>

      {showFindReplace && (
        <Suspense fallback={null}>
          <LazyFindReplacePanel noteIds={noteIds} onClose={() => setShowFindReplace(false)} />
        </Suspense>
      )}

      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          data-testid="bulk-message"
          className={`text-xs ${message.kind === 'error' ? 'text-rose-600 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
