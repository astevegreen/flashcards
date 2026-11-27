import {
  planFindReplace,
  planFindReplaceUndo,
  searchableFields,
  type FindReplaceChange,
  type FindReplaceError,
  type FindReplaceOptions,
  type FindReplacePlan,
} from '@flash/core/find-replace';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../state/AppContext.tsx';

export interface FindReplacePanelProps {
  /** Selected note ids (already limited to the visible list). */
  noteIds: readonly string[];
  onClose: () => void;
}

const buttonClass =
  'rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:opacity-90 disabled:opacity-40';
const inputClass =
  'min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs';

const PREVIEW_COUNT = 3;
/** Pause in typing before the live count and preview update. */
const PREVIEW_DELAY_MS = 200;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 'es'}`;
}

function notesText(n: number): string {
  return `${n} note${n === 1 ? '' : 's'}`;
}

function linkedWarning(count: number): string {
  if (count === 0) return '';
  const verb = count === 1 ? 'is' : 'are';
  return ` ${notesText(count)} ${verb} in a deck linked to a Sheet, folder or package; the next refresh may bring the old text back.`;
}

function skippedText(count: number): string {
  if (count === 0) return '';
  if (count === 1) return ' 1 field was edited since and kept as it is.';
  return ` ${count} fields were edited since and kept as they are.`;
}

function describeError(error: FindReplaceError): string {
  return error.code === 'empty_find'
    ? 'Type the text to find.'
    : `That pattern is not a valid regular expression: ${error.message}`;
}

/** A field's text on one line, cut to 60 characters, for the preview. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

/**
 * Find and replace across the selected notes (Browse bulk edit), lazily loaded from the bulk
 * edit bar. The plan comes from core (`@flash/core/find-replace`) and is appended as one batch
 * of `NoteUpserted` events carrying only the changed fields. "Undo replace" puts the old text
 * back in each field that still holds the replaced text.
 */
export function FindReplacePanel({ noteIds, onClose }: Readonly<FindReplacePanelProps>) {
  const { state, stateVersion, emitEvents, getEventFactory } = useApp();
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const [lastChanges, setLastChanges] = useState<FindReplaceChange[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fields = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const id of noteIds) {
      const note = state.notes.get(id);
      const typeId = note ? state.decks.get(note.deck_id)?.note_type_id : undefined;
      for (const f of searchableFields(typeId ? state.noteTypes.get(typeId) : undefined)) {
        if (!byKey.has(f.key)) byKey.set(f.key, f.label);
      }
    }
    return [...byKey.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, noteIds]);

  const options = useMemo<FindReplaceOptions>(
    () => ({ find, replace, matchCase, regex, ...(fieldKey ? { fieldKey } : {}) }),
    [find, replace, matchCase, regex, fieldKey],
  );

  // The live count and preview run the plan (the pattern over every selected note) once typing
  // pauses, not on each keystroke (P7). Replace plans again from the current input, so it stays
  // enabled while the preview is behind the input and replaces what is typed, not the old preview.
  const [planned, setPlanned] = useState<{
    options: FindReplaceOptions;
    plan: FindReplacePlan;
  } | null>(null);
  const plan = planned?.plan ?? null;
  const previewBehind = planned?.options !== options;
  // Clearing the Find box drops the preview (in its onChange), so an empty pattern plans nothing.
  useEffect(() => {
    if (options.find.length === 0) return;
    const timer = window.setTimeout(
      () => setPlanned({ options, plan: planFindReplace(state, noteIds, options) }),
      PREVIEW_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state, stateVersion, noteIds, options]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (options.find.length === 0) return;
    const current = planFindReplace(state, noteIds, options);
    setPlanned({ options, plan: current });
    if (current.error || current.payloads.length === 0) return;
    const factory = getEventFactory();
    const nowMs = Date.now();
    emitEvents(current.payloads.map((p) => factory.create('NoteUpserted', p, nowMs)));
    setLastChanges(current.changes);
    setMessage(
      `Replaced ${plural(current.replacementCount, 'match')} in ${notesText(current.changedNoteCount)}.${linkedWarning(current.linkedNoteCount)}`,
    );
  };

  const undo = () => {
    if (!lastChanges) return;
    const undoPlan = planFindReplaceUndo(state, lastChanges);
    if (undoPlan.payloads.length > 0) {
      const factory = getEventFactory();
      const nowMs = Date.now();
      emitEvents(undoPlan.payloads.map((p) => factory.create('NoteUpserted', p, nowMs)));
    }
    setLastChanges(null);
    setMessage(
      `Put back the old text in ${undoPlan.restoredCount} field${undoPlan.restoredCount === 1 ? '' : 's'}.${skippedText(undoPlan.skippedCount)}`,
    );
  };

  let summary: { kind: 'ok' | 'error'; text: string } | null = null;
  if (plan?.error) summary = { kind: 'error', text: describeError(plan.error) };
  else if (plan) {
    summary = {
      kind: 'ok',
      text:
        plan.replacementCount === 0
          ? 'No matches in the selected notes.'
          : `${plural(plan.replacementCount, 'match')} in ${notesText(plan.changedNoteCount)}.`,
    };
  }

  return (
    <form
      onSubmit={apply}
      data-testid="find-replace-panel"
      aria-label="Find and replace"
      className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          aria-label="Find"
          data-testid="find-replace-find"
          placeholder="Find…"
          value={find}
          onChange={(e) => {
            setFind(e.target.value);
            if (e.target.value.length === 0) setPlanned(null);
            setMessage(null);
          }}
          className={`${inputClass} w-40`}
        />
        <input
          aria-label="Replace with"
          data-testid="find-replace-replace"
          placeholder="Replace with…"
          value={replace}
          onChange={(e) => {
            setReplace(e.target.value);
            setMessage(null);
          }}
          className={`${inputClass} w-40`}
        />
        <select
          aria-label="Field to search"
          data-testid="find-replace-field"
          value={fieldKey}
          onChange={(e) => setFieldKey(e.target.value)}
          className={inputClass}
        >
          <option value="">All text fields</option>
          {fields.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            data-testid="find-replace-match-case"
            checked={matchCase}
            onChange={(e) => setMatchCase(e.target.checked)}
          />
          <span>Match case</span>
        </label>
        <label
          className="flex items-center gap-1 text-xs"
          title="JavaScript syntax; use $1 in the replacement for the first group"
        >
          <input
            type="checkbox"
            data-testid="find-replace-regex"
            checked={regex}
            onChange={(e) => setRegex(e.target.checked)}
          />
          <span>Regular expression</span>
        </label>
        <span className="flex-1" />
        <button
          type="submit"
          data-testid="find-replace-apply"
          disabled={
            find.length === 0 ||
            (!previewBehind && (!plan || !!plan.error || plan.payloads.length === 0))
          }
          className={buttonClass}
        >
          Replace
        </button>
        {lastChanges && (
          <button
            type="button"
            data-testid="find-replace-undo"
            onClick={undo}
            className={buttonClass}
          >
            Undo replace
          </button>
        )}
        <button
          type="button"
          data-testid="find-replace-close"
          onClick={onClose}
          className={buttonClass}
        >
          Close
        </button>
      </div>
      <p className="text-xs text-[var(--muted)]">
        Searches the text fields of the selected notes. Image and audio links are never changed.
      </p>
      {summary && !message && summary.kind === 'error' && (
        <p
          role="alert"
          data-testid="find-replace-summary"
          className="text-xs text-rose-600 dark:text-rose-300"
        >
          {summary.text}
        </p>
      )}
      {summary && !message && summary.kind === 'ok' && (
        <output data-testid="find-replace-summary" className="block text-xs">
          {summary.text}
        </output>
      )}
      {plan && !plan.error && !message && plan.changes.length > 0 && (
        <ul data-testid="find-replace-preview" className="flex flex-col gap-0.5 text-xs">
          {plan.changes.slice(0, PREVIEW_COUNT).map((c) => (
            <li key={`${c.noteId}:${c.fieldKey}`} className="truncate">
              <span className="text-[var(--muted)] line-through">{excerpt(c.before)}</span>
              {' → '}
              <span>{excerpt(c.after)}</span>
            </li>
          ))}
          {plan.changes.length > PREVIEW_COUNT && (
            <li className="text-[var(--muted)]">
              and {plan.changes.length - PREVIEW_COUNT} more field
              {plan.changes.length - PREVIEW_COUNT === 1 ? '' : 's'}
            </li>
          )}
        </ul>
      )}
      {message && (
        <output
          data-testid="find-replace-message"
          className="block text-xs text-emerald-700 dark:text-emerald-300"
        >
          {message}
        </output>
      )}
    </form>
  );
}
