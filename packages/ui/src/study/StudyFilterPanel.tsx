import {
  applyFilterPreset,
  BUILTIN_FILTER_PRESETS,
  buildStudyQueue,
  filterCards,
  isCardFilterEmpty,
  listCategories,
  normalizeCardFilter,
  type CardFilter,
  type CategoryCriterion,
} from '@flash/core';
import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { CategoryPicker } from './CategoryPicker.tsx';
import { useBrowseFilter, type ActiveStudyFilter } from './filterStore.ts';

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
 * Presets layer performance criteria on top. Sessions run on schedule: only cards that are due
 * now are queued, with the normal FSRS state, daily limits and sibling burying.
 */
export function StudyFilterPanel({ deckId, onStart, onClose }: StudyFilterPanelProps) {
  const { state, stateVersion } = useApp();
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

  const options = useMemo<FilterOption[]>(() => {
    const base = normalizeCardFilter({ deckIds, categories });
    const custom = normalizeCardFilter({ ...base, states: browseFilter.states ?? [] });
    const list: FilterOption[] = [];
    if (!isCardFilterEmpty(custom)) {
      list.push({
        id: 'custom',
        label: 'Study this filter',
        description: 'Due cards from the chosen decks and categories.',
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
  }, [deckIds, categories, browseFilter.states]);

  const counts = useMemo(() => {
    const nowMs = Date.now();
    const tzOffsetMinutes = -new Date(nowMs).getTimezoneOffset();
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
            </li>
          );
        })}
      </ul>
    </div>
  );
}
