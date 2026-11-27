import { deriveNoteId, uuidv7 } from '../ids.ts';
import type { EventFactory } from '../events/replay.ts';
import type { KnownEvent } from '../events/types.ts';
import { ownField } from '../model/note-fields.ts';
import type { Note, NoteType } from '../model/types.ts';
import { convertAnkiRuby } from './anki-ruby.ts';
import { normalizeTagList } from '../tags/index.ts';
import { splitTagCell } from './tag-cell.ts';
import {
  columnDisplayName,
  joinNotes,
  notesFieldKey,
  notesLine,
  type ColumnTarget,
} from './column-target.ts';

export * from './csv-export.ts';
export { escapeDelimitedCell, type CsvCellOptions } from './csv-cell.ts';

export interface CsvParseOptions {
  delimiter?: ',' | '\t';
}

export interface CsvParseResult {
  delimiter: ',' | '\t';
  headers: string[];
  rows: string[][];
}

/**
 * Lenient RFC 4180-style CSV/TSV parser (it accepts input the RFC rejects, such as a stray quote
 * inside an unquoted field).
 * - Strips UTF-8 BOM
 * - Auto-detects `,` vs `\t` from first non-empty line when delimiter is omitted
 * - Handles quoted newlines, commas/tabs inside quotes, and escaped `""`
 * - Drops completely empty trailing rows
 */
export function parseDelimitedText(raw: string, options?: CsvParseOptions): CsvParseResult {
  const { delimiter, headers, rows } = parseCells(raw, options);
  return { delimiter, headers, rows };
}

/**
 * `parseDelimitedText` plus each cell's quote flag and row 1 untrimmed: what `buildEventsFromCsv`
 * reads, so a preview grid can show the cells exactly as they import (C17).
 */
export function parseDelimitedTable(raw: string, options?: CsvParseOptions): ParsedCells {
  return parseCells(raw, options);
}

export interface ParsedCells extends CsvParseResult {
  /** `quoted[r][c]`: cell `rows[r][c]` was written in quotes, so its spaces are content (C17). */
  quoted: boolean[][];
  /** Row 1 untrimmed, with its quote flags: the first data row when there is no header row. */
  firstRow: string[];
  firstQuoted: boolean[];
}

function parseCells(raw: string, options?: CsvParseOptions): ParsedCells {
  const input = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  if (input.trim().length === 0) {
    return { ...EMPTY_CELLS, delimiter: options?.delimiter ?? ',' };
  }

  const delimiter = options?.delimiter ?? detectDelimiter(input);
  const allRows: string[][] = [];
  const allQuoted: boolean[][] = [];
  let row: string[] = [];
  let rowQuoted: boolean[] = [];
  let field = '';
  let fieldQuoted = false;
  // Where the closing quote fell: spaces after it are not content, so they go (C17).
  let quoteEnd = -1;
  let inQuotes = false;
  // Where the current field's opening quote is, and an opening quote that turned out not to be
  // one: it never closed, or text follows its closing quote (C1). That quote is read again as a
  // plain character, so a lone `"` (say one closed by a curly `”`) no longer swallows the rows
  // after it, and `"philopon", methamphetamine` keeps its quotes in a TSV.
  let quoteStart = -1;
  let literalQuoteAt = -1;
  // Where the current field's text began: spaces before an opening quote are dropped, as RFC
  // tolerant readers do (`a, "b"` reads as `a,"b"`), and read again if that quote turns literal.
  let fieldStart = 0;
  const endField = () => {
    if (quoteEnd >= 0) field = field.slice(0, quoteEnd) + field.slice(quoteEnd).trimEnd();
    row.push(field);
    rowQuoted.push(fieldQuoted);
    field = '';
    fieldQuoted = false;
    quoteEnd = -1;
    quoteStart = -1;
  };
  /** Reparses the field from its start (any spaces, then the quote), as plain text. */
  const unquote = (): number => {
    literalQuoteAt = quoteStart;
    field = '';
    fieldQuoted = false;
    quoteEnd = -1;
    quoteStart = -1;
    inQuotes = false;
    return fieldStart - 1;
  };
  const endRow = () => {
    endField();
    allRows.push(row);
    allQuoted.push(rowQuoted);
    row = [];
    rowQuoted = [];
  };

  for (let i = 0; ; i++) {
    if (i >= input.length) {
      if (!inQuotes) break;
      i = unquote();
      continue;
    }
    const ch = input[i];
    if (ch === undefined) continue;
    if (!inQuotes && field.length === 0 && quoteEnd < 0) fieldStart = i;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          quoteEnd = field.length;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && quoteEnd < 0 && isBlank(field) && i !== literalQuoteAt) {
      field = '';
      inQuotes = true;
      fieldQuoted = true;
      quoteStart = i;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\r') {
      if (input[i + 1] === '\n') i += 1;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else if (quoteEnd >= 0 && !/\s/.test(ch)) {
      i = unquote();
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) endRow();

  // Drop trailing empty rows
  while (allRows.length > 0) {
    const lastRow = allRows[allRows.length - 1];
    if (lastRow && lastRow.every((c) => c.trim() === '')) {
      allRows.pop();
      allQuoted.pop();
    } else {
      break;
    }
  }

  const headerRow = allRows[0];
  if (!headerRow) {
    return { ...EMPTY_CELLS, delimiter };
  }

  const headers = headerRow.map((h) => h.trim());
  const rows: string[][] = [];
  const quoted: boolean[][] = [];
  for (let r = 1; r < allRows.length; r++) {
    const cells = allRows[r];
    // A row of blanks is dropped, even one of quoted spaces: a note needs some text.
    if (!cells?.some((cell) => cell.trim() !== '')) continue;
    rows.push(cells);
    quoted.push(allQuoted[r] ?? []);
  }
  return { delimiter, headers, rows, quoted, firstRow: headerRow, firstQuoted: allQuoted[0] ?? [] };
}

/** Only spaces (the delimiter, a tab, never reaches a field in a TSV). */
function isBlank(text: string): boolean {
  for (const ch of text) if (ch !== ' ' && ch !== '\t') return false;
  return true;
}

/** A cell with something in it: text, or spaces written inside quotes (`"   "`). */
function hasContent(cell: string, quoted: boolean): boolean {
  return cell.trim() !== '' || (quoted && cell.length > 0);
}

const EMPTY_CELLS = { headers: [], rows: [], quoted: [], firstRow: [], firstQuoted: [] };

function detectDelimiter(input: string): ',' | '\t' {
  // Inspect first line outside quotes
  let inQuotes = false;
  let commas = 0;
  let tabs = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === undefined) continue;
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (ch === '\n' || ch === '\r') break;
      if (ch === ',') commas += 1;
      if (ch === '\t') tabs += 1;
    }
  }
  return tabs > commas ? '\t' : ',';
}

export interface CsvImportWarning {
  code: 'unknown_header' | 'duplicate_header' | 'duplicate_card_id' | 'empty_row_skipped';
  message: string;
  row?: number;
  header?: string;
}

export interface CsvImportResult {
  events: KnownEvent[];
  importedCount: number;
  warnings: CsvImportWarning[];
  mappedHeaders: Record<string, string>;
}

/**
 * Maps parsed CSV/TSV rows into NoteUpserted events for a target deck & note type.
 * Matches headers by Note Type field key/label (case-insensitive), plus:
 * - `Card ID` / `card_id` / `id` / `source_key` -> note `source_key`
 * - `Tags` / `Category 1..N` (Flashcards Deluxe) -> note `tags` (NFC, deduped; see `exportCsv`)
 * - `Text 1..N` (Flashcards Deluxe) -> positional Note Type fields
 */
export function buildEventsFromCsv(
  csvText: string,
  options: {
    deckId: string;
    noteType: NoteType;
    eventFactory: EventFactory;
    delimiter?: ',' | '\t';
    nowMs?: number;
    /** Convert Anki space-delimited furigana (` 漢字[かんじ]`) to app ruby syntax (§6.2). */
    ankiRuby?: boolean;
    /**
     * The collection's notes (e.g. `state.notes.values()`). A row whose Card ID matches the
     * `source_key` of a note already in `deckId` updates that note, as `.flashpkg` import does,
     * even when its id was not derived from this deck (a note moved here from another deck).
     */
    existingNotes?: Iterable<Note>;
    /**
     * Where each column goes, by position (the Bring my cards mapping step). Replaces matching
     * headers by name; columns past the end of the list are not imported.
     */
    columns?: readonly ColumnTarget[];
    /** `false` when row 1 is already data (no header row). Defaults to `true`. */
    hasHeaderRow?: boolean;
  },
): CsvImportResult {
  const { deckId, noteType, eventFactory } = options;
  const nowMs = options.nowMs ?? Date.now();
  const parsed = parseCells(
    csvText,
    options.delimiter ? { delimiter: options.delimiter } : undefined,
  );
  const warnings: CsvImportWarning[] = [];
  const mappedHeaders: Record<string, string> = {};

  if (parsed.headers.length === 0) {
    return { events: [], importedCount: 0, warnings, mappedHeaders };
  }
  const hasHeaderRow = options.hasHeaderRow ?? true;
  // Without a header row, row 1 is data, read like any other row: put it back in front.
  const dataRows = hasHeaderRow ? parsed.rows : [parsed.firstRow, ...parsed.rows];
  const dataQuoted = hasHeaderRow ? parsed.quoted : [parsed.firstQuoted, ...parsed.quoted];
  const headerNames = hasHeaderRow ? parsed.headers : [];
  // 1-based file row of `dataRows[i]`.
  const rowOffset = hasHeaderRow ? 2 : 1;

  const fieldByLookup = new Map<string, string>();
  for (const field of noteType.fields) {
    fieldByLookup.set(field.key.toLowerCase(), field.key);
    fieldByLookup.set(field.label.toLowerCase(), field.key);
  }

  const notesKey = notesFieldKey(noteType);
  const explicitRoles = options.columns?.map((target, index): ColumnTarget => {
    const header = columnDisplayName(headerNames[index] ?? '', index);
    if (target.kind === 'notes' && !notesKey) return { kind: 'ignore' };
    if (target.kind === 'field' && !noteType.fields.some((f) => f.key === target.fieldKey)) {
      return { kind: 'ignore' };
    }
    if (target.kind === 'field') mappedHeaders[header] = target.fieldKey;
    else if (target.kind === 'card_id') mappedHeaders[header] = 'source_key';
    else if (target.kind !== 'ignore') mappedHeaders[header] = target.kind;
    return target;
  });

  const seenNormalized = new Set<string>();
  const columnRoles: ColumnTarget[] =
    explicitRoles ??
    parsed.headers.map((header) => {
      const norm = header.trim().toLowerCase();
      if (!norm) return { kind: 'ignore' };

      if (seenNormalized.has(norm)) {
        warnings.push({
          code: 'duplicate_header',
          header,
          message: `Duplicate column header "${header}" ignored.`,
        });
        return { kind: 'ignore' };
      }
      seenNormalized.add(norm);

      if (norm === 'card id' || norm === 'card_id' || norm === 'id' || norm === 'source_key') {
        mappedHeaders[header] = 'source_key';
        return { kind: 'card_id' };
      }

      if (norm === 'tags' || norm === 'tag' || /^category\s*\d*$/.test(norm)) {
        mappedHeaders[header] = 'tags';
        return { kind: 'tags' };
      }

      const directField = fieldByLookup.get(norm);
      if (directField) {
        mappedHeaders[header] = directField;
        return { kind: 'field', fieldKey: directField };
      }

      // Flashcards Deluxe compatibility: "Text 1", "Text 2", "Text 3", ...
      const textNumMatch = /^text\s*(\d+)$/.exec(norm);
      if (textNumMatch) {
        const idx = Number(textNumMatch[1]) - 1;
        const targetField = noteType.fields[idx];
        if (targetField) {
          mappedHeaders[header] = targetField.key;
          return { kind: 'field', fieldKey: targetField.key };
        }
      }

      warnings.push({
        code: 'unknown_header',
        header,
        message: `Unknown column header "${header}" was ignored.`,
      });
      return { kind: 'ignore' };
    });

  const existingIdBySourceKey = new Map<string, string>();
  for (const note of options.existingNotes ?? []) {
    if (note.deck_id === deckId && note.source_key) {
      existingIdBySourceKey.set(note.source_key, note.id);
    }
  }

  const events: KnownEvent[] = [];
  const seenSourceKeys = new Set<string>();

  for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
    const row = dataRows[rowIdx];
    // A row of blanks is dropped, as `parseCells` drops the later ones: row 1, when it is data,
    // is the one that reaches here, even as quoted spaces (`"   ","   "`).
    if (!row?.some((cell) => cell.trim() !== '')) continue;
    const fields: Record<string, string> = {};
    const rawTags: string[] = [];
    const notes: string[] = [];
    let rawSourceKey = '';

    for (let colIdx = 0; colIdx < columnRoles.length; colIdx++) {
      const role = columnRoles[colIdx];
      if (!role) continue;
      // A quoted cell keeps its spaces, so exportCsv round-trips them (C17); unquoted is trimmed.
      // A quoted cell of spaces only (`"   "`) is kept as spaces, but only in a field.
      const cell = row[colIdx] ?? '';
      const quoted = dataQuoted[rowIdx]?.[colIdx] === true && role.kind !== 'card_id';
      if (!hasContent(cell, quoted && role.kind === 'field')) continue;
      const value = quoted ? cell : cell.trim();

      if (role.kind === 'field') {
        const text = options.ankiRuby ? convertAnkiRuby(value) : value;
        const prev = ownField(fields, role.fieldKey);
        // Two columns into one field (only the mapping step allows it, for Notes) are joined.
        fields[role.fieldKey] = prev && explicitRoles ? `${prev}\n${text}` : text;
      } else if (role.kind === 'tags') {
        rawTags.push(...splitTagCell(value));
      } else if (role.kind === 'card_id') {
        if (!rawSourceKey) rawSourceKey = value;
      } else if (role.kind === 'notes') {
        notes.push(notesLine(headerNames[colIdx] ?? '', colIdx, value));
      }
    }
    if (notesKey && notes.length > 0)
      fields[notesKey] = joinNotes(ownField(fields, notesKey), notes);

    if (Object.keys(fields).length === 0) {
      warnings.push({
        code: 'empty_row_skipped',
        row: rowIdx + rowOffset,
        message: `Row ${rowIdx + rowOffset} had no mapped field values and was skipped.`,
      });
      continue;
    }

    let sourceKey = rawSourceKey;
    if (!sourceKey) {
      sourceKey = uuidv7(nowMs);
    } else if (seenSourceKeys.has(sourceKey)) {
      const replacement = uuidv7(nowMs);
      warnings.push({
        code: 'duplicate_card_id',
        row: rowIdx + rowOffset,
        message: `Duplicate Card ID "${sourceKey}" on row ${rowIdx + rowOffset}; assigned new ID "${replacement}".`,
      });
      sourceKey = replacement;
    }
    seenSourceKeys.add(sourceKey);

    const noteId = existingIdBySourceKey.get(sourceKey) ?? deriveNoteId(deckId, sourceKey);
    events.push(
      eventFactory.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: deckId,
          source_key: sourceKey,
          fields,
          // NFC so Hangul from macOS (NFD) and Windows (NFC) land in one category.
          tags: normalizeTagList(rawTags),
          provenance: { source: 'import', reviewed: true },
          created_order: rowIdx,
        },
        nowMs,
      ),
    );
  }

  return {
    events,
    importedCount: events.length,
    warnings,
    mappedHeaders,
  };
}
