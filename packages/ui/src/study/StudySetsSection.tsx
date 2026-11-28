import {
  buildStudyQueue,
  buildStudySetSavedPayload,
  filterCards,
  listStudySets,
  normalizeCardFilter,
  STUDY_SET_NAME_MAX_LENGTH,
  type CardFilter,
  type CollectionState,
  type EventFactory,
  type KnownEvent,
  type StudySet,
  type StudySetMode,
} from '@flash/core';
import { useMemo, useState } from 'react';

// Now and the UTC offset, read outside the component body: the React Compiler's purity check
// cannot tell a handler or a memo there from render code. Kept per file so it adds no shared chunk.
const readClock = (nowMs = Date.now()) => ({
  nowMs,
  tzOffsetMinutes: -new Date(nowMs).getTimezoneOffset(),
});

const BTN =
  'rounded-lg border border-[var(--border)] px-2 py-0.5 text-xs font-medium hover:bg-[var(--surface-2)] disabled:opacity-40';

export interface StudySetEventDeps {
  getEventFactory: () => EventFactory;
  emitEvents: (events: readonly KnownEvent[]) => void;
}

/** Appends one `StudySetSaved` (create or edit). Returns false when nothing valid was given. */
export function saveStudySet(
  deps: StudySetEventDeps,
  input: { setId: string; name?: string; filter?: CardFilter; mode?: StudySetMode },
): boolean {
  const payload = buildStudySetSavedPayload(input);
  if (!payload) return false;
  deps.emitEvents([deps.getEventFactory().create('StudySetSaved', payload, Date.now())]);
  return true;
}

export interface SaveStudySetFormProps {
  defaultName: string;
  defaultMode?: StudySetMode;
  onSave: (name: string, mode: StudySetMode) => void;
  onCancel: () => void;
}

/** Inline "Save as study set" form: a name and how the set is studied. */
export function SaveStudySetForm({
  defaultName,
  defaultMode = 'schedule',
  onSave,
  onCancel,
}: SaveStudySetFormProps) {
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState<StudySetMode>(defaultMode);
  const valid = name.trim().length > 0;
  return (
    <form
      data-testid="study-set-save-form"
      className="mt-1 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-[var(--border)] p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(name, mode);
      }}
    >
      <input
        aria-label="Study set name"
        data-testid="study-set-name-input"
        value={name}
        maxLength={STUDY_SET_NAME_MAX_LENGTH}
        onChange={(e) => setName(e.target.value)}
        className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs"
      />
      <select
        aria-label="Study set mode"
        data-testid="study-set-mode-select"
        value={mode}
        onChange={(e) => setMode(e.target.value === 'practice' ? 'practice' : 'schedule')}
        className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs"
      >
        <option value="schedule">On schedule (due cards)</option>
        <option value="practice">Practice (all matches)</option>
      </select>
      <button type="submit" data-testid="study-set-save-confirm" disabled={!valid} className={BTN}>
        Save
      </button>
      <button type="button" onClick={onCancel} className={BTN}>
        Cancel
      </button>
    </form>
  );
}

export interface StudySetsSectionProps {
  state: CollectionState;
  stateVersion: number;
  deps: StudySetEventDeps;
  /** Deck chosen in the Study header (`undefined` = all decks). */
  deckId: string | undefined;
  onStudy: (set: StudySet) => void;
}

/**
 * The selection a set's session really runs on: a set naming its own decks runs on those decks
 * whatever the Study header shows (see `resolveStudyQueueDeckId`); any other set is limited to
 * the header deck. Row counts use it so they match what starting the set queues.
 */
export function studySetScopeFilter(filter: CardFilter, deckId: string | undefined): CardFilter {
  if (deckId === undefined || (filter.deckIds?.length ?? 0) > 0) return filter;
  return normalizeCardFilter({ ...filter, deckIds: [deckId] });
}

/**
 * Saved Study Sets (Phase 9): named filters that sync as `StudySetSaved` / `StudySetDeleted`
 * events. Names are plain text rendered by React, never HTML (§13).
 */
export function StudySetsSection({
  state,
  stateVersion,
  deps,
  deckId,
  onStudy,
}: StudySetsSectionProps) {
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const rows = useMemo(() => {
    const { nowMs, tzOffsetMinutes } = readClock();
    return listStudySets(state).map((set) => {
      const filter = studySetScopeFilter(set.filter, deckId);
      return {
        set,
        matching: filterCards(state, filter, { nowMs, tzOffsetMinutes, excludeSuspended: true })
          .length,
        dueNow: buildStudyQueue(state, { nowMs, tzOffsetMinutes, filter }).counts.total,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, deckId]);

  return (
    <section aria-label="Study sets" data-testid="study-sets" className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">Study sets</h3>
      {rows.length === 0 ? (
        <p data-testid="study-sets-empty" className="text-xs text-[var(--muted)]">
          No saved sets yet. Use “Save as set” on any filter below; sets sync to your other devices.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(({ set, matching, dueNow }) => (
            <li
              key={set.id}
              data-testid="study-set-row"
              className="flex flex-col gap-1 rounded-xl border border-[var(--border)] px-3 py-2"
            >
              {renaming?.id === set.id ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (saveStudySet(deps, { setId: set.id, name: renaming.name })) {
                      setRenaming(null);
                    }
                  }}
                >
                  <input
                    aria-label="New study set name"
                    data-testid="study-set-rename-input"
                    value={renaming.name}
                    maxLength={STUDY_SET_NAME_MAX_LENGTH}
                    onChange={(e) => setRenaming({ id: set.id, name: e.target.value })}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs"
                  />
                  <button
                    type="submit"
                    data-testid="study-set-rename-confirm"
                    disabled={renaming.name.trim().length === 0}
                    className={BTN}
                  >
                    Save
                  </button>
                  <button type="button" onClick={() => setRenaming(null)} className={BTN}>
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    data-testid="study-set-start"
                    onClick={() => onStudy(set)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span
                      data-testid="study-set-name"
                      className="block truncate text-sm font-semibold"
                    >
                      {set.name}
                    </span>
                    <span className="block text-xs text-[var(--muted)]">
                      <span data-testid="study-set-mode">
                        {set.mode === 'practice' ? 'Practice' : 'On schedule'}
                      </span>
                      {' · '}
                      <span data-testid="study-set-count" className="tabular-nums">
                        {dueNow} due · {matching} cards
                      </span>
                    </span>
                  </button>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      data-testid="study-set-rename"
                      onClick={() => setRenaming({ id: set.id, name: set.name })}
                      className={BTN}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      data-testid="study-set-delete"
                      onClick={() => {
                        if (confirmDelete !== set.id) {
                          setConfirmDelete(set.id);
                          return;
                        }
                        setConfirmDelete(null);
                        deps.emitEvents([
                          deps
                            .getEventFactory()
                            .create('StudySetDeleted', { set_id: set.id }, Date.now()),
                        ]);
                      }}
                      className={BTN}
                    >
                      {confirmDelete === set.id ? 'Confirm delete' : 'Delete'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
