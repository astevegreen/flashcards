import type { Deck, NoteType, SourceColumnMapping } from '@flash/core';
import {
  guessDeckSetup,
  looksLikeHeaderRow,
  resolveSourceColumnMap,
  toSourceColumnMap,
} from '@flash/core/import-mapping';
import { useMemo, useState } from 'react';
import { ColumnMappingView, useColumnMapping } from '../import/ColumnMapping.tsx';
import { useApp } from '../state/AppContext.tsx';

const LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'ko', label: 'ko' },
  { code: 'ja', label: 'ja' },
  { code: 'zh-Hans', label: 'zh' },
  { code: 'en', label: 'en' },
];

export interface LinkedFileMappingChoice {
  noteTypeId: string;
  language: string;
  columnMap: SourceColumnMapping[];
}

function Mapping({
  grid,
  noteType,
  savedMap,
  disabled,
  testIdPrefix,
  onLink,
}: Readonly<{
  grid: string[][];
  noteType: NoteType;
  savedMap: SourceColumnMapping[] | undefined;
  disabled: boolean;
  testIdPrefix: string;
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
          data-testid={`${testIdPrefix}-link-confirm-btn`}
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
 * Column-mapping step for linking a cloud spreadsheet file (shared by Google Drive, OneDrive,
 * and Dropbox): pick the note type and language for a new deck, map each column, then link.
 * `existingDeck` is the deck the file already fills.
 */
export default function LinkedFileMapping({
  fileName,
  grid,
  existingDeck,
  busy,
  testIdPrefix,
  onLink,
  onCancel,
  cancelLabel = 'Back',
}: Readonly<{
  fileName: string;
  grid: string[][];
  existingDeck: Deck | undefined;
  busy: boolean;
  testIdPrefix: string;
  onLink: (choice: LinkedFileMappingChoice) => void;
  onCancel: () => void;
  cancelLabel?: string;
}>) {
  const { state } = useApp();
  const setup = useMemo(() => guessDeckSetup(grid, { hasHeaderRow: true }), [grid]);
  const [chosenNoteTypeId, setChosenNoteTypeId] = useState(setup.noteTypeId);
  const [language, setLanguage] = useState(setup.language);
  const noteTypes = [...state.noteTypes.values()];
  const noteTypeId = [existingDeck?.note_type_id, chosenNoteTypeId, 'preset:vocab-ko'].find(
    (id) => id && state.noteTypes.has(id),
  );
  const noteType = noteTypeId ? state.noteTypes.get(noteTypeId) : undefined;

  return (
    <div
      data-testid={`${testIdPrefix}-link-mapping`}
      className="flex h-full flex-col gap-2 overflow-y-auto"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-semibold">Link “{fileName}”</p>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-lg border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-2)] disabled:opacity-40"
        >
          {cancelLabel}
        </button>
      </div>
      {existingDeck ? (
        <p className="text-[11px] text-[var(--muted)]">
          Already linked to the deck “{existingDeck.name}”. Linking again updates it with this
          mapping.
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
          savedMap={existingDeck?.source?.column_map}
          disabled={busy}
          testIdPrefix={testIdPrefix}
          onLink={(columnMap) => onLink({ noteTypeId: noteType.id, language, columnMap })}
        />
      ) : (
        <p className="text-rose-600 dark:text-rose-400">Choose a note type for the new deck.</p>
      )}
    </div>
  );
}
