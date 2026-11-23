import { type CollectionState, type NoteType } from '@flash/core';
import {
  guessDeckSetup,
  looksLikeHeaderRow,
  resolveSourceColumnMap,
  toSourceColumnMap,
} from '@flash/core/import-mapping';
import type { SourceColumnMapping } from '@flash/core';
import { useMemo, useState } from 'react';
import { ColumnMappingView, useColumnMapping } from '../import/ColumnMapping.tsx';
import { useApp } from '../state/AppContext.tsx';

const LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'ko', label: 'ko' },
  { code: 'ja', label: 'ja' },
  { code: 'zh-Hans', label: 'zh' },
  { code: 'en', label: 'en' },
];

/** The deck a OneDrive file is already linked to, if any (its note type then can't change). */
export function linkedOneDriveDeck(state: CollectionState, itemId: string) {
  for (const deck of state.decks.values()) {
    if (deck.source?.kind === 'onedrive_file' && deck.source.external_id === itemId) return deck;
  }
  return undefined;
}

function Mapping({
  grid,
  noteType,
  savedMap,
  disabled,
  onLink,
}: Readonly<{
  grid: string[][];
  noteType: NoteType;
  savedMap: SourceColumnMapping[] | undefined;
  disabled: boolean;
  onLink: (columnMap: SourceColumnMapping[]) => void;
}>) {
  const saved = useMemo(
    () => (savedMap ? resolveSourceColumnMap(grid[0] ?? [], savedMap, noteType) : undefined),
    [grid, savedMap, noteType],
  );
  const mapping = useColumnMapping(grid, noteType, {
    forceHeaderRow: true,
    ...(saved ? { saved } : {}),
  });
  return (
    <>
      {!looksLikeHeaderRow(grid, noteType) && (
        <p className="text-[11px] text-[var(--muted)]">
          The first row is read as column names. If it holds a card, add a row of names above it.
        </p>
      )}
      <ColumnMappingView
        grid={grid}
        noteType={noteType}
        mapping={mapping}
        disabled={disabled}
        headerRowFixed
      />
      <div>
        <button
          type="button"
          data-testid="onedrive-link-confirm-btn"
          disabled={disabled || mapping.blocked}
          onClick={() => onLink(toSourceColumnMap(grid[0] ?? [], mapping.targets))}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          Link this file
        </button>
      </div>
    </>
  );
}

/**
 * Column-mapping step for linking a OneDrive spreadsheet (same step as linking a Google Sheet in
 * Bring my cards): pick the note type and language for a new deck, map each column, then link.
 */
export default function OneDriveLinkMapping({
  itemId,
  fileName,
  grid,
  busy,
  onLink,
  onCancel,
}: Readonly<{
  itemId: string;
  fileName: string;
  grid: string[][];
  busy: boolean;
  onLink: (choice: {
    noteTypeId: string;
    language: string;
    columnMap: SourceColumnMapping[];
  }) => void;
  onCancel: () => void;
}>) {
  const { state } = useApp();
  const existing = linkedOneDriveDeck(state, itemId);
  const setup = useMemo(() => guessDeckSetup(grid, { hasHeaderRow: true }), [grid]);
  const [chosenNoteTypeId, setChosenNoteTypeId] = useState(setup.noteTypeId);
  const [language, setLanguage] = useState(setup.language);
  const noteTypes = [...state.noteTypes.values()];
  const noteTypeId = [existing?.note_type_id, chosenNoteTypeId, 'preset:vocab-ko'].find(
    (id) => id && state.noteTypes.has(id),
  );
  const noteType = noteTypeId ? state.noteTypes.get(noteTypeId) : undefined;

  return (
    <div data-testid="onedrive-link-mapping" className="flex h-full flex-col gap-2 overflow-y-auto">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-semibold">Link “{fileName}”</p>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-2)] disabled:opacity-40"
        >
          Back
        </button>
      </div>
      {existing ? (
        <p className="text-[11px] text-[var(--muted)]">
          Already linked to the deck “{existing.name}”. Linking again updates it with this mapping.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Linked file note type"
            value={noteTypeId ?? ''}
            disabled={busy}
            onChange={(e) => setChosenNoteTypeId(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
          >
            {noteTypes.map((nt) => (
              <option key={nt.id} value={nt.id}>
                {nt.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Linked file language"
            value={language}
            disabled={busy}
            onChange={(e) => setLanguage(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {noteType ? (
        <Mapping
          key={noteType.id}
          grid={grid}
          noteType={noteType}
          savedMap={existing?.source?.column_map}
          disabled={busy}
          onLink={(columnMap) => onLink({ noteTypeId: noteType.id, language, columnMap })}
        />
      ) : (
        <p className="text-rose-600 dark:text-rose-400">Choose a note type for the new deck.</p>
      )}
    </div>
  );
}
