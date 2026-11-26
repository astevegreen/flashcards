import {
  compareCodeUnits,
  encodeUtf8,
  filterNoteIds,
  listCategories,
  normalizeCardFilter,
  type CollectionState,
} from '@flash/core';
import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';

export interface CategoryExportPanelProps {
  /** Local media blobs for `.flashpkg` (only those the exported notes reference are packed). */
  collectMediaBlobs: () => Promise<Map<string, Uint8Array>>;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  /** Compact styling when rendered inside ImportExportPanel. */
  embedded?: boolean;
}

const selectClass =
  'min-w-0 max-w-[16rem] truncate rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs';
const buttonClass =
  'rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:opacity-90 disabled:opacity-40';

/** ASCII file-name slug (`Korean Core` -> `korean-core`), or `fallback` when nothing is left. */
function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
  return slug || fallback;
}

/** Active notes in `tag` (and its `::` nested tags), optionally in one deck. */
function categoryNoteIds(state: CollectionState, tag: string, deckId: string): string[] {
  if (!tag) return [];
  const nowMs = Date.now();
  const filter = normalizeCardFilter({
    deckIds: deckId ? [deckId] : [],
    categories: { mode: 'any', tags: [tag] },
  });
  const ids = filterNoteIds(state, filter, {
    nowMs,
    tzOffsetMinutes: -new Date(nowMs).getTimezoneOffset(),
  });
  return [...ids].sort(compareCodeUnits);
}

/**
 * Library "Export a tag" (Phase 9): the notes of one tag (and its `::` nested tags)
 * as CSV (one deck at a time, Flashcards Deluxe `Category N` columns) or as a `.flashpkg` that
 * keeps the tags (the CSV keeps the Flashcards Deluxe `Category N` column names). Lazily loaded; Browse keeps its bulk-bar CSV export for
 * hand-picked selections. Names render as plain text (§13).
 */
export function CategoryExportPanel({
  collectMediaBlobs,
  onStatus,
  onError,
  embedded = false,
}: Readonly<CategoryExportPanelProps>) {
  const { platform, state, stateVersion } = useApp();
  const [tag, setTag] = useState('');
  const [deckChoice, setDeckChoice] = useState('');
  const [forOtherApps, setForOtherApps] = useState(false);

  const categories = useMemo(
    () => listCategories(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );
  const selectedTag = categories.some((c) => c.tag === tag) ? tag : '';

  // Decks that hold notes of the tag (the deck picker only offers those).
  const decksWithTag = useMemo(() => {
    const ids = new Set(
      categoryNoteIds(state, selectedTag, '').map((id) => state.notes.get(id)?.deck_id),
    );
    return [...state.decks.values()]
      .filter((d) => !d.archived && ids.has(d.id))
      .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, selectedTag]);

  const deckId = decksWithTag.some((d) => d.id === deckChoice) ? deckChoice : '';
  // CSV holds one deck (its columns are that deck's fields): the chosen deck, or the only one.
  const csvDeck = deckId ? state.decks.get(deckId) : undefined;
  const csvDeckOrOnly = csvDeck ?? (decksWithTag.length === 1 ? decksWithTag[0] : undefined);
  const notesText = (n: number) => `${n} note${n === 1 ? '' : 's'}`;
  const tagSlug = slugify(selectedTag.replaceAll('::', '-'), 'tag');

  const exportCsvFile = async () => {
    if (!selectedTag || !csvDeckOrOnly) return;
    try {
      const { exportCsv } = await import('@flash/core/csv');
      const noteIds = categoryNoteIds(state, selectedTag, csvDeckOrOnly.id);
      const result = exportCsv(state, {
        deckId: csvDeckOrOnly.id,
        noteIds,
        ...(forOtherApps ? { stripRichText: true } : {}),
      });
      const file = `${slugify(csvDeckOrOnly.name, 'deck')}-${tagSlug}.csv`;
      await platform.files.downloadFile(file, encodeUtf8(result.text), 'text/csv');
      onStatus(`Exported ${notesText(result.noteCount)} in #${selectedTag} to ${file}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const exportFlashpkgFile = async () => {
    if (!selectedTag) return;
    try {
      const { exportFlashpkg } = await import('@flash/core/flashpkg');
      const noteIds = categoryNoteIds(state, selectedTag, deckId);
      const bytes = exportFlashpkg(state, {
        noteIds,
        ...(deckId ? { deckId } : {}),
        name: `#${selectedTag}`,
        mediaBlobs: await collectMediaBlobs(),
      });
      const file = `${tagSlug}.flashpkg`;
      await platform.files.downloadFile(file, bytes, 'application/zip');
      onStatus(`Exported ${notesText(noteIds.length)} in #${selectedTag} as ${file}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const Heading = embedded ? 'h3' : 'h2';
  return (
    <section
      aria-label="Export a tag"
      data-testid="category-export-panel"
      className={
        embedded
          ? 'flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3'
          : 'flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4'
      }
    >
      <div>
        <Heading className={embedded ? 'text-xs font-semibold' : 'text-sm font-semibold'}>
          Export a tag
        </Heading>
        <p className={embedded ? 'text-[11px] text-[var(--muted)]' : 'text-xs text-[var(--muted)]'}>
          Every note in a tag (and its <code>::</code> nested tags) as CSV or .flashpkg, with its
          tags kept. To export hand-picked notes, select them in Words.
        </p>
      </div>
      {categories.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">No tags yet. Add them to notes in Words.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Tag to export"
            data-testid="category-export-tag"
            value={selectedTag}
            onChange={(e) => setTag(e.target.value)}
            className={selectClass}
          >
            <option value="">Choose a tag…</option>
            {categories.map((c) => (
              <option key={c.tag} value={c.tag}>
                #{c.tag} ({c.noteCount})
              </option>
            ))}
          </select>
          <select
            aria-label="Deck to export from"
            data-testid="category-export-deck"
            value={deckId}
            disabled={!selectedTag}
            onChange={(e) => setDeckChoice(e.target.value)}
            className={selectClass}
          >
            <option value="">All decks</option>
            {decksWithTag.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="category-export-csv"
            disabled={!selectedTag || !csvDeckOrOnly}
            title={
              selectedTag && !csvDeckOrOnly ? 'CSV exports one deck at a time: choose a deck' : ''
            }
            onClick={() => void exportCsvFile()}
            className={buttonClass}
          >
            Export CSV
          </button>
          <label
            className="flex items-center gap-1 text-xs"
            title="Plain text for Excel, Sheets or Numbers: drops formatting marks and stops cells running as formulas"
          >
            <input
              type="checkbox"
              data-testid="category-export-for-other-apps"
              checked={forOtherApps}
              onChange={(e) => setForOtherApps(e.target.checked)}
            />
            For other apps
          </label>
          <button
            type="button"
            data-testid="category-export-flashpkg"
            disabled={!selectedTag}
            onClick={() => void exportFlashpkgFile()}
            className={buttonClass}
          >
            Export .flashpkg
          </button>
        </div>
      )}
    </section>
  );
}

export default CategoryExportPanel;
