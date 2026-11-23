import {
  planFindReplace,
  planFindReplaceUndo,
  searchableFields,
  type FindReplaceChange,
  type FindReplaceError,
} from '@flash/core/find-replace';
import { useMemo, useState, type FormEvent } from 'react';
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 'es'}`;
}

function notesText(n: number): string {
  return `${n} note${n === 1 ? '' : 's'}`;
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
export function FindReplacePanel({ noteIds, onClose }: FindReplacePanelProps) {
  const { state, stateVersion, emitEvents, getEventFactory } = useApp();
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const [lastChanges, setLastChanges] = useState<FindReplaceChange[] | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

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

  const plan = useMemo(
    () =>
      find.length === 0
        ? null
        : planFindReplace(state, noteIds, {
            find,
            replace,
            matchCase,
            regex,
            ...(fieldKey ? { fieldKey } : {}),
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, noteIds, find, replace, matchCase, regex, fieldKey],
  );

  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (!plan || plan.error || plan.payloads.length === 0) return;
    const factory = getEventFactory();
    const nowMs = Date.now();
    emitEvents(plan.payloads.map((p) => factory.create('NoteUpserted', p, nowMs)));
    setLastChanges(plan.changes);
    const linked =
      plan.linkedNoteCount > 0
        ? ` ${notesText(plan.linkedNoteCount)} ${plan.linkedNoteCount === 1 ? 'is' : 'are'} in a deck linked to a Sheet, folder or package; the next refresh may bring the old text back.`
        : '';
    setMessage({
      kind: 'ok',
      text: `Replaced ${plural(plan.replacementCount, 'match')} in ${notesText(plan.changedNoteCount)}.${linked}`,
    });
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
    const skipped =
      undoPlan.skippedCount > 0
        ? ` ${undoPlan.skippedCount} field${undoPlan.skippedCount === 1 ? ' was' : 's were'} edited since and kept as ${undoPlan.skippedCount === 1 ? 'it is' : 'they are'}.`
        : '';
    setMessage({
      kind: 'ok',
      text: `Put back the old text in ${undoPlan.restoredCount} field${undoPlan.restoredCount === 1 ? '' : 's'}.${skipped}`,
    });
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
          Match case
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
          Regular expression
        </label>
        <span className="flex-1" />
        <button
          type="submit"
          data-testid="find-replace-apply"
          disabled={!plan || !!plan.error || plan.payloads.length === 0}
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
      {summary && !message && (
        <p
          role={summary.kind === 'error' ? 'alert' : 'status'}
          data-testid="find-replace-summary"
          className={`text-xs ${summary.kind === 'error' ? 'text-rose-600 dark:text-rose-300' : ''}`}
        >
          {summary.text}
        </p>
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
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          data-testid="find-replace-message"
          className="text-xs text-emerald-700 dark:text-emerald-300"
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
