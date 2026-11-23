import type { NoteType } from '@flash/core';
import {
  decodeColumnTarget,
  encodeColumnTarget,
  guessColumnMapping,
  hasMappingProblems,
  looksLikeHeaderRow,
  mappingProblems,
  notesFieldKey,
  previewMappedRows,
  type ColumnGuess,
  type ColumnGuessReason,
  type ColumnTarget,
  type MappedRow,
  type MappingProblems,
} from '@flash/core/import-mapping';
import { useMemo, useState } from 'react';

/**
 * The Bring my cards column-mapping step: one card per column (its name, a few values, and where
 * it goes), the "first row has column names" switch, what blocks the import, and a preview of
 * the first notes exactly as they will be stored. Lives in the lazy Bring my cards chunk.
 */

const PREVIEW_VALUE_CHARS = 80;

type Reason = ColumnGuessReason | 'saved' | 'chosen';

const REASON_TEXT: Record<Reason, string> = {
  header: 'Matched by its name',
  content: 'Guessed from its values',
  position: 'Guessed from the column order',
  empty: 'Empty column',
  unknown: 'Not recognized',
  saved: 'As linked before',
  chosen: 'Your choice',
};

export interface MappedColumn extends ColumnGuess {
  shownReason: Reason;
}

export interface ColumnMappingState {
  hasHeaderRow: boolean;
  setHasHeaderRow: (value: boolean) => void;
  columns: MappedColumn[];
  targets: ColumnTarget[];
  /** Header names as the importer sees them (`Column N` without a header row). */
  headers: string[];
  setTarget: (index: number, target: ColumnTarget) => void;
  problems: MappingProblems;
  blocked: boolean;
}

interface Edits {
  key: string;
  byIndex: ReadonlyMap<number, ColumnTarget>;
}

/**
 * Holds the guess and the user's changes. A different note type or header switch guesses again
 * (the fields on offer change), dropping earlier changes. `saved` targets (a Sheet linked before)
 * replace the guess for the columns they name.
 */
export function useColumnMapping(
  grid: readonly (readonly string[])[],
  noteType: NoteType,
  options: { forceHeaderRow?: boolean; saved?: readonly (ColumnTarget | undefined)[] } = {},
): ColumnMappingState {
  const [headerChoice, setHeaderChoice] = useState<boolean | null>(null);
  const hasHeaderRow =
    options.forceHeaderRow === true || (headerChoice ?? looksLikeHeaderRow(grid, noteType));
  const guess = useMemo(
    () => guessColumnMapping(grid, noteType, { hasHeaderRow }),
    [grid, noteType, hasHeaderRow],
  );
  const key = `${noteType.id}|${hasHeaderRow}`;
  const [edits, setEdits] = useState<Edits>({ key, byIndex: new Map() });
  const byIndex = edits.key === key ? edits.byIndex : new Map<number, ColumnTarget>();
  const saved = hasHeaderRow ? options.saved : undefined;

  const columns = guess.columns.map((col): MappedColumn => {
    const edited = byIndex.get(col.index);
    if (edited) return { ...col, target: edited, shownReason: 'chosen' };
    const fromSaved = saved?.[col.index];
    if (fromSaved) return { ...col, target: fromSaved, shownReason: 'saved' };
    return { ...col, shownReason: col.reason };
  });
  const targets = columns.map((c) => c.target);
  const problems = mappingProblems(targets, noteType);
  return {
    hasHeaderRow,
    setHasHeaderRow: setHeaderChoice,
    columns,
    targets,
    headers: columns.map((c) => c.header),
    setTarget: (index, target) => {
      const next = new Map(byIndex);
      next.set(index, target);
      setEdits({ key, byIndex: next });
    },
    problems,
    blocked: hasMappingProblems(problems),
  };
}

const FIELD =
  'min-w-0 max-w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs';

function fieldLabel(noteType: NoteType, key: string): string {
  return noteType.fields.find((f) => f.key === key)?.label ?? key;
}

function problemLines(problems: MappingProblems, noteType: NoteType): string[] {
  const lines: string[] = [];
  if (problems.missingFront) {
    lines.push(
      `Choose a column for ${fieldLabel(noteType, problems.missingFront)} (the front of the card).`,
    );
  }
  for (const key of problems.duplicateFields) {
    lines.push(
      `Two columns go to ${fieldLabel(noteType, key)}. Choose one, or send the other to Notes.`,
    );
  }
  if (problems.duplicateCardId) lines.push('Only one column can be the Card ID.');
  return lines;
}

/**
 * Preview rows keyed by what they hold (the preview is rebuilt as a whole, so rows have no other
 * identity); a repeated row gets a `#n` suffix.
 */
export function keyedPreviewRows(rows: readonly MappedRow[]): { key: string; row: MappedRow }[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = JSON.stringify([row.fields, row.tags, row.cardId]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n === 0 ? base : `${base}#${n}`, row };
  });
}

function clip(value: string): string {
  // Line breaks stay (Notes lines); other runs of white space become one space.
  const chars = [...value.replaceAll(/[^\S\n]+/g, ' ')];
  return chars.length > PREVIEW_VALUE_CHARS
    ? `${chars.slice(0, PREVIEW_VALUE_CHARS).join('')}…`
    : chars.join('');
}

interface TargetSelectProps {
  column: MappedColumn;
  noteType: NoteType;
  disabled: boolean;
  onChange: (target: ColumnTarget) => void;
}

function TargetSelect({ column, noteType, disabled, onChange }: Readonly<TargetSelectProps>) {
  const hasNotes = notesFieldKey(noteType) !== undefined;
  return (
    <select
      aria-label={`Where the column “${column.header}” goes`}
      data-testid={`bring-map-target-${column.index}`}
      value={encodeColumnTarget(column.target)}
      disabled={disabled}
      onChange={(e) => {
        const target = decodeColumnTarget(e.target.value, noteType);
        if (target) onChange(target);
      }}
      className={`w-full ${FIELD}`}
    >
      <optgroup label="Card field">
        {noteType.fields.map((f) => (
          <option key={f.key} value={`field:${f.key}`}>
            {f.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Other">
        <option value="tags">Category (tag)</option>
        {hasNotes && <option value="notes">Add to Notes</option>}
        <option value="card_id">Card ID</option>
        <option value="ignore">Don’t import</option>
      </optgroup>
    </select>
  );
}

interface ColumnMappingViewProps {
  grid: readonly (readonly string[])[];
  noteType: NoteType;
  mapping: ColumnMappingState;
  disabled: boolean;
  /** Hide the header switch (a linked Sheet always has a header row: Card IDs are written there). */
  headerRowFixed?: boolean;
}

export function ColumnMappingView({
  grid,
  noteType,
  mapping,
  disabled,
  headerRowFixed = false,
}: Readonly<ColumnMappingViewProps>) {
  const preview = previewMappedRows(grid, mapping.targets, noteType, {
    hasHeaderRow: mapping.hasHeaderRow,
  });
  const problems = problemLines(mapping.problems, noteType);
  return (
    <div data-testid="bring-mapping" className="flex flex-col gap-2">
      <div>
        <p className="font-semibold">Where each column goes</p>
        <p className="text-[11px] text-[var(--muted)]">
          Guessed for you. Change any that are wrong: Category columns become tags, Add to Notes
          keeps a column as “name: value” lines.
        </p>
      </div>
      {!headerRowFixed && (
        <label className="flex min-w-0 items-center gap-1.5">
          <input
            type="checkbox"
            data-testid="bring-map-header-row"
            checked={mapping.hasHeaderRow}
            disabled={disabled}
            onChange={(e) => mapping.setHasHeaderRow(e.target.checked)}
          />
          <span className="min-w-0 break-words">The first row has column names</span>
        </label>
      )}
      <ul className="flex flex-col gap-1.5">
        {mapping.columns.map((column) => (
          <li
            key={column.index}
            data-testid={`bring-map-col-${column.index}`}
            data-target={encodeColumnTarget(column.target)}
            className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--border)] p-2"
          >
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
              <span className="min-w-0 font-semibold break-words">{column.header}</span>
              <span className="text-[10px] text-[var(--muted)]">
                {REASON_TEXT[column.shownReason]}
              </span>
            </div>
            <p className="min-w-0 text-[11px] break-words text-[var(--muted)]">
              {column.samples.length > 0 ? column.samples.map(clip).join(' · ') : '(no values)'}
            </p>
            <TargetSelect
              column={column}
              noteType={noteType}
              disabled={disabled}
              onChange={(target) => mapping.setTarget(column.index, target)}
            />
          </li>
        ))}
      </ul>
      {problems.length > 0 && (
        <ul
          data-testid="bring-map-problems"
          className="list-disc pl-5 text-[11px] text-rose-700 dark:text-rose-300"
        >
          {problems.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <div>
        <p className="font-semibold">Preview</p>
        {preview.length === 0 ? (
          <p className="text-[11px] text-[var(--muted)]">No row has a value in a chosen column.</p>
        ) : (
          <ol data-testid="bring-map-preview" className="flex flex-col gap-1">
            {keyedPreviewRows(preview).map(({ key, row }) => (
              <li key={key} className="rounded-md bg-[var(--surface-2)] px-2 py-1 text-[11px]">
                {noteType.fields
                  .filter((f) => row.fields[f.key])
                  .map((f) => (
                    <p key={f.key} className="break-words whitespace-pre-line">
                      <span className="font-semibold">{f.label}:</span>{' '}
                      {clip(row.fields[f.key] ?? '')}
                    </p>
                  ))}
                {row.tags.length > 0 && (
                  <p className="break-words">
                    <span className="font-semibold">Categories:</span> {row.tags.join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
