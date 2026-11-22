import type { CategoryCount, CategoryCriterion, CategoryMatchMode } from '@flash/core';
import { useState } from 'react';

export interface CategoryPickerProps {
  categories: readonly CategoryCount[];
  value: CategoryCriterion | undefined;
  onChange: (next: CategoryCriterion | undefined) => void;
  /** Extra virtual categories (e.g. `leech`) shown after the note tags. */
  virtualCategories?: readonly CategoryCount[];
  testIdPrefix?: string;
  defaultOpen?: boolean;
}

const MODES: ReadonlyArray<{ mode: CategoryMatchMode; label: string; hint: string }> = [
  { mode: 'any', label: 'Any', hint: 'Notes with at least one selected category' },
  { mode: 'all', label: 'All', hint: 'Notes with every selected category' },
  { mode: 'none', label: 'None', hint: 'Notes with none of the selected categories' },
];

/**
 * Multi-select category (note tag) filter with any / all / none matching (Phase 9).
 * Tags are plain text rendered through React, never as HTML (§13).
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  virtualCategories = [],
  testIdPrefix = 'category',
  defaultOpen = false,
}: CategoryPickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  // Remember the chosen mode even while no tag is selected (an empty criterion is `undefined`).
  const [pendingMode, setPendingMode] = useState<CategoryMatchMode>(value?.mode ?? 'any');
  const selected = new Set(value?.tags ?? []);
  const mode: CategoryMatchMode = value?.mode ?? pendingMode;

  const update = (tags: Set<string>, nextMode: CategoryMatchMode) => {
    setPendingMode(nextMode);
    onChange(
      tags.size > 0
        ? { mode: nextMode, tags: [...tags].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }
        : undefined,
    );
  };

  const toggleTag = (tag: string) => {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    update(next, mode);
  };

  const options = [...categories, ...virtualCategories];

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-testid={`${testIdPrefix}-toggle`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
          selected.size > 0
            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
            : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--fg)]'
        }`}
      >
        Categories{selected.size > 0 ? ` · ${mode} of ${selected.size}` : ''}
      </button>

      {open && (
        <div
          role="group"
          aria-label="Category filter"
          data-testid={`${testIdPrefix}-panel`}
          className="flex w-full flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-[var(--muted)]">Match</span>
            <div className="inline-flex rounded-lg border border-[var(--border)] p-0.5 text-xs font-semibold">
              {MODES.map((m) => (
                <button
                  key={m.mode}
                  type="button"
                  title={m.hint}
                  aria-pressed={mode === m.mode}
                  data-testid={`${testIdPrefix}-mode-${m.mode}`}
                  onClick={() => update(selected, m.mode)}
                  className={`rounded-md px-2 py-0.5 ${
                    mode === m.mode
                      ? 'bg-[var(--accent)] text-white'
                      : 'text-[var(--muted)] hover:text-[var(--fg)]'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {selected.size > 0 && (
              <button
                type="button"
                data-testid={`${testIdPrefix}-clear`}
                onClick={() => onChange(undefined)}
                className="ml-auto text-xs font-medium text-[var(--muted)] underline hover:text-[var(--fg)]"
              >
                Clear
              </button>
            )}
          </div>

          {options.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">No categories yet.</p>
          ) : (
            <ul className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
              {options.map((c) => {
                const checked = selected.has(c.tag);
                return (
                  <li key={c.tag}>
                    <label
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                        checked
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-2)]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        data-testid={`${testIdPrefix}-option-${c.tag}`}
                        onChange={() => toggleTag(c.tag)}
                      />
                      <span>#{c.tag}</span>
                      <span className="tabular-nums text-[var(--muted)]">{c.noteCount}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
