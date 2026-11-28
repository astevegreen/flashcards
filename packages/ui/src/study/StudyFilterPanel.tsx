import {
  applyFilterPreset,
  BUILTIN_FILTER_PRESETS,
  buildStudyQueue,
  filterCards,
  isCardFilterEmpty,
  listCategories,
  normalizeCardFilter,
  uuidv7,
  type CardFilter,
  type CategoryCriterion,
  type StudySet,
} from '@flash/core';
import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { CategoryPicker } from './CategoryPicker.tsx';
import { CustomStudySection } from './CustomStudySection.tsx';
import { useBrowseFilter, type ActiveStudyFilter } from './filterStore.ts';
import { createPracticeSession } from './studySessions.ts';
import { SaveStudySetForm, saveStudySet, StudySetsSection } from './StudySetsSection.tsx';

// Now and the UTC offset, read outside the component body: the React Compiler's purity check
// cannot tell a handler or a memo there from render code. Kept per file so it adds no shared chunk.
const readClock = (nowMs = Date.now()) => ({
  nowMs,
  tzOffsetMinutes: -new Date(nowMs).getTimezoneOffset(),
});

const SMALL_BTN =
  'rounded-lg border border-[var(--border)] px-2 py-0.5 text-xs font-medium hover:bg-[var(--surface-2)]';

export interface StudyFilterPanelProps {
  /** Deck chosen in the Study header (`undefined` = all decks). */
  deckId: string | undefined;
  onStart: (active: ActiveStudyFilter) => void;
  onClose: () => void;
}

interface FilterOption {
  id: string;
  label: string;
  description: string;
  filter: CardFilter;
}

/**
 * "Study this filter" (Phase 9), lazily loaded so the study critical path stays in budget (§8).
 * Scope = the Study deck selection (or Browse's decks) plus categories, prefilled from Browse.
 * Presets layer performance criteria on top. "Study" runs on schedule: only cards that are due
 * now are queued, with the normal FSRS state, daily limits and sibling burying. "Practice" crams
 * every match without touching FSRS. Any filter can be saved as a synced Study Set, and the
 * Custom study section adds review ahead and extra new cards today.
 */
export function StudyFilterPanel({ deckId, onStart, onClose }: StudyFilterPanelProps) {
  const { state, stateVersion, getEventFactory, emitEvents } = useApp();
  const [savingOptionId, setSavingOptionId] = useState<string | null>(null);
  const deps = { state, getEventFactory, emitEvents };
  const startPractice = (label: string, filter: CardFilter) =>
    onStart({ label: `${label} · practice`, filter, session: createPracticeSession(deps, filter) });
  const studySet = (set: StudySet) =>
    set.mode === 'practice'
      ? startPractice(set.name, set.filter)
      : onStart({ label: set.name, filter: set.filter });
  const browseFilter = useBrowseFilter();
  const [categories, setCategories] = useState<CategoryCriterion | undefined>(
    browseFilter.categories,
  );

  const deckIds = useMemo(
    () => (deckId !== undefined ? [deckId] : [...(browseFilter.deckIds ?? [])]),
    [deckId, browseFilter.deckIds],
  );

  const categoryOptions = useMemo(
    () => listCategories(state, { deckIds }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, deckIds],
  );

  const baseFilter = useMemo(
    () => normalizeCardFilter({ deckIds, categories }),
    [deckIds, categories],
  );

  const options = useMemo<FilterOption[]>(() => {
    const base = baseFilter;
    const custom = normalizeCardFilter({ ...base, states: browseFilter.states ?? [] });
    const list: FilterOption[] = [];
    if (!isCardFilterEmpty(custom)) {
      list.push({
        id: 'custom',
        label: 'Study this filter',
        description: 'Due cards from the chosen decks and tags.',
        filter: custom,
      });
    }
    for (const preset of BUILTIN_FILTER_PRESETS) {
      list.push({
        id: preset.id,
        label: preset.name,
        description: preset.description,
        filter: applyFilterPreset(base, preset.id),
      });
    }
    return list;
  }, [baseFilter, browseFilter.states]);

  const counts = useMemo(() => {
    const { nowMs, tzOffsetMinutes } = readClock();
    const out = new Map<string, { matching: number; dueNow: number }>();
    for (const opt of options) {
      const matching = filterCards(state, opt.filter, {
        nowMs,
        tzOffsetMinutes,
        excludeSuspended: true,
      }).length;
      const dueNow = buildStudyQueue(state, { nowMs, tzOffsetMinutes, filter: opt.filter }).counts
        .total;
      out.set(opt.id, { matching, dueNow });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, options]);

  const deckName =
    deckIds.length === 0
      ? 'All decks'
      : deckIds.map((id) => state.decks.get(id)?.name ?? 'Unknown deck').join(', ');

  return (
    <div
      role="dialog"
      aria-label="Study this filter"
      data-testid="study-filter-panel"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold">Study this filter</h2>
          <p className="text-xs text-[var(--muted)]">
            Scope: <span data-testid="study-filter-scope">{deckName}</span>
          </p>
        </div>
        <button
          type="button"
          data-testid="study-filter-close"
          onClick={onClose}
          className="rounded-lg border border-[var(--border)] px-2 py-0.5 text-xs font-medium hover:bg-[var(--surface-2)]"
        >
          Close
        </button>
      </div>

      <CategoryPicker
        categories={categoryOptions}
        value={categories}
        onChange={setCategories}
        testIdPrefix="study-filter-category"
        defaultOpen={categories !== undefined}
      />

      <ul className="flex flex-col gap-2">
        {options.map((opt) => {
          const c = counts.get(opt.id) ?? { matching: 0, dueNow: 0 };
          return (
            <li key={opt.id}>
              <button
                type="button"
                data-testid={`study-filter-start-${opt.id}`}
                onClick={() => onStart({ label: opt.label, filter: opt.filter })}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-3 py-2 text-left hover:bg-[var(--surface-2)]"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{opt.label}</span>
                  <span className="block text-xs text-[var(--muted)]">{opt.description}</span>
                </span>
                <span
                  data-testid={`study-filter-count-${opt.id}`}
                  className="shrink-0 text-right text-xs tabular-nums text-[var(--muted)]"
                >
                  {c.dueNow} due · {c.matching} cards
                </span>
              </button>
              <div className="mt-1 flex justify-end gap-1">
                <button
                  type="button"
                  data-testid={`study-filter-practice-${opt.id}`}
                  disabled={c.matching === 0}
                  onClick={() => startPractice(opt.label, opt.filter)}
                  className={`${SMALL_BTN} disabled:opacity-40`}
                >
                  Practice
                </button>
                <button
                  type="button"
                  data-testid={`study-filter-save-${opt.id}`}
                  aria-expanded={savingOptionId === opt.id}
                  onClick={() => setSavingOptionId((v) => (v === opt.id ? null : opt.id))}
                  className={SMALL_BTN}
                >
                  Save as set
                </button>
              </div>
              {savingOptionId === opt.id && (
                <SaveStudySetForm
                  defaultName={deckIds.length === 0 ? opt.label : `${opt.label} (${deckName})`}
                  onCancel={() => setSavingOptionId(null)}
                  onSave={(name, mode) => {
                    if (saveStudySet(deps, { setId: uuidv7(), name, filter: opt.filter, mode })) {
                      setSavingOptionId(null);
                    }
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>

      <StudySetsSection
        state={state}
        stateVersion={stateVersion}
        deps={deps}
        deckId={deckId}
        onStudy={studySet}
      />

      <CustomStudySection
        state={state}
        stateVersion={stateVersion}
        deps={deps}
        deckIds={deckIds}
        filter={baseFilter}
        onStart={onStart}
        onDone={onClose}
      />
    </div>
  );
}
