import {
  createBulkEvents,
  planBulkNoteAction,
  type BulkNoteAction,
  type Note,
  noteField,
} from '@flash/core';
import { DUPLICATE_TAG, findDuplicateGroups, planDuplicateTagAdds } from '@flash/core/duplicates';
import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';

// Now and the UTC offset, read outside the component body: the React Compiler's purity check
// cannot tell a handler or a memo there from render code. Kept per file so it adds no shared chunk.
const readClock = (nowMs = Date.now()) => ({
  nowMs,
  tzOffsetMinutes: -new Date(nowMs).getTimezoneOffset(),
});

/** Groups shown per page; "Show more" reveals the next page. */
const PAGE_SIZE = 50;

export interface DuplicateFinderPanelProps {
  /** Opens a note in the Browse editor. */
  onOpen: (note: Note) => void;
  onClose: () => void;
}

const buttonClass =
  'shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:opacity-90 disabled:opacity-40';

const notesText = (n: number) => `${n} note${n === 1 ? '' : 's'}`;

/**
 * Duplicate finder, lazily loaded from Browse: notes whose key field matches after NFC, trimming
 * and ruby stripping (`@flash/core/duplicates`), grouped across decks. Open, tag or archive go
 * through the same planned bulk events as the bulk edit bar. Text renders as plain text (§13).
 */
export function DuplicateFinderPanel({ onOpen, onClose }: Readonly<DuplicateFinderPanelProps>) {
  const { state, stateVersion, emitEvents, getEventFactory } = useApp();
  const [acrossDecksOnly, setAcrossDecksOnly] = useState(true);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [message, setMessage] = useState<string | null>(null);

  const groups = useMemo(
    () => findDuplicateGroups(state, { acrossDecksOnly }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, acrossDecksOnly],
  );

  const tagGroup = (noteIds: readonly string[]) => {
    // Set-union adds (`NoteTagsAdded`), so a concurrent tag edit elsewhere is never overwritten.
    const payloads = planDuplicateTagAdds(state, noteIds);
    if (payloads.length > 0) {
      const factory = getEventFactory();
      const { nowMs } = readClock();
      emitEvents(payloads.map((p) => factory.create('NoteTagsAdded', p, nowMs)));
    }
    setMessage(`Tagged "${DUPLICATE_TAG}" on ${notesText(payloads.length)}.`);
  };

  const run = (noteIds: readonly string[], action: BulkNoteAction, verb: string) => {
    const plan = planBulkNoteAction(state, noteIds, action);
    if (plan.error) {
      setMessage('That change could not be made.');
      return;
    }
    if (plan.events.length > 0) {
      emitEvents(createBulkEvents(getEventFactory(), plan.events, Date.now()));
    }
    setMessage(`${verb} ${notesText(plan.changedNoteCount)}.`);
  };

  const secondaryText = (note: Note): string => {
    const deck = state.decks.get(note.deck_id);
    const fields = state.noteTypes.get(deck?.note_type_id ?? '')?.fields ?? [];
    const meaning = fields.find((f) => f.key === 'meaning') ?? fields[1];
    return meaning ? (noteField(note, meaning.key) ?? '') : '';
  };

  return (
    <div
      role="region"
      aria-label="Duplicates"
      data-testid="duplicate-finder"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold">
          Duplicates{' '}
          <span
            data-testid="duplicate-group-count"
            className="text-sm font-normal text-[var(--muted)]"
          >
            ({groups.length})
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-[var(--muted)]">
            <input
              type="checkbox"
              data-testid="duplicate-across-decks"
              checked={acrossDecksOnly}
              onChange={(e) => {
                setAcrossDecksOnly(e.target.checked);
                setShown(PAGE_SIZE);
              }}
            />
            Only across decks
          </label>
          <button type="button" onClick={onClose} className={buttonClass}>
            Close
          </button>
        </div>
      </div>
      <p className="text-xs text-[var(--muted)]">
        Notes with the same key field (such as Word or Hanja), ignoring ruby readings and extra
        spaces, in decks of the same language. Useful when an imported list (HSK, JLPT) overlaps
        your own decks. Archiving keeps a note&apos;s review history; you can restore it from Words.
      </p>
      {message && (
        <div data-testid="duplicate-message" className="text-xs text-[var(--muted)]">
          {message}
        </div>
      )}
      {groups.length === 0 ? (
        <div className="py-4 text-center text-sm text-[var(--muted)]">No duplicates found.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.slice(0, shown).map((group) => {
            const notes = group.noteIds
              .map((id) => state.notes.get(id))
              .filter((n): n is Note => n !== undefined);
            return (
              <li
                key={`${group.language}:${group.key}`}
                data-testid="duplicate-group"
                className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold" lang={group.language}>
                    {group.key}
                    <span className="ml-2 text-xs font-normal text-[var(--muted)]">
                      {notesText(notes.length)} in {group.deckIds.length} deck
                      {group.deckIds.length === 1 ? '' : 's'}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid="duplicate-tag-group"
                    onClick={() => tagGroup(group.noteIds)}
                    className={buttonClass}
                  >
                    Tag “{DUPLICATE_TAG}”
                  </button>
                </div>
                <ul className="flex flex-col gap-1">
                  {notes.map((note) => (
                    <li
                      key={note.id}
                      data-testid={`duplicate-note-${note.id}`}
                      className="flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-semibold">
                          {state.decks.get(note.deck_id)?.name ?? 'Deck'}
                        </span>
                        <span className="ml-2 text-[var(--muted)]">{secondaryText(note)}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <button
                          type="button"
                          data-testid="duplicate-open"
                          onClick={() => onOpen(note)}
                          className={buttonClass}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          data-testid="duplicate-archive"
                          onClick={() => run([note.id], { kind: 'archive' }, 'Archived')}
                          className={buttonClass}
                        >
                          Archive
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
      {groups.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE_SIZE)}
          className={`${buttonClass} self-center`}
        >
          Show more ({groups.length - shown} left)
        </button>
      )}
    </div>
  );
}
