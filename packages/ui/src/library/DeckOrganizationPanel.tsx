import {
  getDeckOrganization,
  listDeckFolders,
  listDeckPresets,
  listPresetDeckIds,
  type DeckPreset,
  type DeckPresetSettings,
} from '@flash/core';
import { Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { lazyWithRetry } from '../lazy/lazyWithRetry.tsx';
import { useApp } from '../state/AppContext.tsx';
import { useDeckOrganization } from './useDeckOrganization.ts';

const LazyFsrsOptimizerPanel = lazyWithRetry(() => import('../fsrs/FsrsOptimizerPanel.tsx'));

const inputClass =
  'rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--fg)]';
const buttonClass =
  'rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)] disabled:opacity-40';
const dangerClass =
  'rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-500/20 dark:text-rose-400';

/**
 * A number field that saves on blur or Enter, within `[min, max]` (rounded to `step` places).
 * An invalid entry snaps back to the stored value.
 */
export function CommitNumberInput({
  label,
  value,
  min,
  max,
  decimals = 0,
  testId,
  onCommit,
}: Readonly<{
  label: string;
  value: number;
  min: number;
  max: number;
  decimals?: number;
  testId?: string;
  onCommit: (next: number) => void;
}>) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(parsed) || parsed < min || parsed > max) {
      setDraft(String(value));
      return;
    }
    const f = 10 ** decimals;
    const next = Math.round(parsed * f) / f;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-[var(--muted)]">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={decimals > 0 ? 1 / 10 ** decimals : 1}
        aria-label={label}
        data-testid={testId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        className={inputClass}
      />
    </label>
  );
}

/** The preset's daily limits and target retention, as editable fields. */
export function PresetSettingsFields({
  preset,
  onChange,
}: Readonly<{ preset: DeckPreset; onChange: (patch: Partial<DeckPresetSettings>) => void }>) {
  const s = preset.settings;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <CommitNumberInput
        label="New cards / day"
        testId={`preset-new-per-day-${preset.id}`}
        value={s.new_cards_per_day}
        min={0}
        max={999}
        onCommit={(v) => onChange({ new_cards_per_day: v })}
      />
      <CommitNumberInput
        label="Max reviews / day"
        testId={`preset-max-reviews-${preset.id}`}
        value={s.max_reviews_per_day}
        min={1}
        max={9999}
        onCommit={(v) => onChange({ max_reviews_per_day: v })}
      />
      <CommitNumberInput
        label="Target retention (0.70–0.99)"
        testId={`preset-retention-${preset.id}`}
        value={s.target_retention}
        min={0.7}
        max={0.99}
        decimals={2}
        onCommit={(v) => onChange({ target_retention: v })}
      />
    </div>
  );
}

function NameField({
  label,
  value,
  testId,
  onCommit,
}: Readonly<{ label: string; value: string; testId: string; onCommit: (next: string) => void }>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.replace(/\s+/g, ' ').trim();
    if (!next) {
      setDraft(value);
      return;
    }
    if (next !== value) onCommit(next);
  };
  return (
    <input
      type="text"
      aria-label={label}
      data-testid={testId}
      value={draft}
      maxLength={80}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      className={`${inputClass} min-w-0 flex-1 font-semibold`}
    />
  );
}

function confirmed(message: string): boolean {
  return typeof window === 'undefined' || window.confirm(message);
}

function PresetRow({ preset }: Readonly<{ preset: DeckPreset }>) {
  const { state, stateVersion } = useApp();
  const actions = useDeckOrganization();
  const [showOptimizer, setShowOptimizer] = useState(false);
  const deckNames = useMemo(
    () =>
      listPresetDeckIds(state, preset.id)
        .map((id) => state.decks.get(id))
        .filter((d) => d !== undefined && !d.archived)
        .map((d) => d?.name ?? ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, preset.id],
  );
  return (
    <div
      data-testid={`preset-row-${preset.id}`}
      className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <NameField
          label="Preset name"
          testId={`preset-name-${preset.id}`}
          value={preset.name}
          onCommit={(name) => actions.updatePreset(preset.id, { name })}
        />
        <button
          type="button"
          aria-expanded={showOptimizer}
          onClick={() => setShowOptimizer((v) => !v)}
          className={buttonClass}
        >
          {showOptimizer ? 'Hide optimizer' : 'Optimize weights'}
        </button>
        <button
          type="button"
          data-testid={`delete-preset-${preset.id}`}
          onClick={() => {
            if (
              confirmed(
                `Delete the preset "${preset.name}"? Its decks keep its limits and retention as their own settings.`,
              )
            ) {
              actions.deletePreset(preset.id);
            }
          }}
          className={dangerClass}
        >
          Delete
        </button>
      </div>
      <p className="text-xs text-[var(--muted)]" data-testid={`preset-decks-${preset.id}`}>
        {deckNames.length === 0
          ? 'No decks use this preset yet. Choose it in a deck’s Options.'
          : `Used by ${deckNames.length} deck(s): ${deckNames.join(', ')}`}
        {preset.w ? ' · Optimized weights' : ' · Each deck keeps its own weights until optimized'}
      </p>
      <PresetSettingsFields
        preset={preset}
        onChange={(settings) => actions.updatePreset(preset.id, { settings })}
      />
      {showOptimizer && (
        <Suspense fallback={null}>
          <LazyFsrsOptimizerPanel preset={preset} />
        </Suspense>
      )}
    </div>
  );
}

function FolderRows() {
  const { state, stateVersion } = useApp();
  const actions = useDeckOrganization();
  const [name, setName] = useState('');
  const folders = useMemo(
    () => listDeckFolders(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const [deckId, folderId] of getDeckOrganization(state).folderByDeck) {
      if (state.decks.get(deckId)?.archived === false) {
        out.set(folderId, (out.get(folderId) ?? 0) + 1);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (actions.createFolder(name)) setName('');
  };
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-[var(--fg)]">Folders</h3>
      {folders.map((folder) => (
        <div
          key={folder.id}
          data-testid={`folder-row-${folder.id}`}
          className="flex flex-wrap items-center gap-2"
        >
          <NameField
            label="Folder name"
            testId={`folder-name-${folder.id}`}
            value={folder.name}
            onCommit={(next) => actions.renameFolder(folder.id, next)}
          />
          <span className="text-xs text-[var(--muted)]">{counts.get(folder.id) ?? 0} deck(s)</span>
          <button
            type="button"
            data-testid={`delete-folder-${folder.id}`}
            onClick={() => {
              if (
                confirmed(
                  `Delete the folder "${folder.name}"? Its decks stay in your library, outside any folder.`,
                )
              ) {
                actions.deleteFolder(folder.id);
              }
            }}
            className={dangerClass}
          >
            Delete
          </button>
        </div>
      ))}
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          aria-label="New folder name"
          data-testid="new-folder-name"
          placeholder="New folder (e.g., Korean)"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button
          type="submit"
          data-testid="create-folder-btn"
          disabled={!name.trim()}
          className={buttonClass}
        >
          Add folder
        </button>
      </form>
    </div>
  );
}

function PresetRows() {
  const { state, stateVersion } = useApp();
  const actions = useDeckOrganization();
  const [name, setName] = useState('');
  const presets = useMemo(
    () => listDeckPresets(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (actions.createPreset(name)) setName('');
  };
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-[var(--fg)]">Option presets</h3>
      <p className="text-xs text-[var(--muted)]">
        A preset shares daily limits, target retention and FSRS weights across decks. Each deck
        still counts its own daily limit. The optimizer pools the reviews of all the preset’s decks.
      </p>
      {presets.map((preset) => (
        <PresetRow key={preset.id} preset={preset} />
      ))}
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          aria-label="New preset name"
          data-testid="new-preset-name"
          placeholder="New preset (e.g., Vocabulary)"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button
          type="submit"
          data-testid="create-preset-btn"
          disabled={!name.trim()}
          className={buttonClass}
        >
          Add preset
        </button>
      </form>
    </div>
  );
}

/** Library panel for deck folders and shared option presets. */
export function DeckOrganizationPanel() {
  const [open, setOpen] = useState(false);
  return (
    <section
      data-testid="deck-organization-panel"
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3"
    >
      <button
        type="button"
        data-testid="toggle-deck-organization-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left text-xs font-semibold text-[var(--muted)] hover:text-[var(--fg)]"
      >
        <span>Folders and option presets</span>
        <span>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-4">
          <FolderRows />
          <PresetRows />
        </div>
      )}
    </section>
  );
}
