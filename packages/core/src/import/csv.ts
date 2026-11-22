import { deriveNoteId, uuidv7 } from '../ids.ts';
import type { EventFactory } from '../events/replay.ts';
import type { KnownEvent } from '../events/types.ts';
import type { NoteType } from '../model/types.ts';
import { convertAnkiRuby } from '../parsers/ruby.ts';
import { normalizeTagList } from '../tags/index.ts';

export * from './csv-export.ts';

export interface CsvParseOptions {
  delimiter?: ',' | '\t';
}

export interface CsvParseResult {
  delimiter: ',' | '\t';
  headers: string[];
  rows: string[][];
}

/**
 * RFC 4180 compliant CSV/TSV parser.
 * - Strips UTF-8 BOM
 * - Auto-detects `,` vs `\t` from first non-empty line when delimiter is omitted
 * - Handles quoted newlines, commas/tabs inside quotes, and escaped `""`
 * - Drops completely empty trailing rows
 */
export function parseDelimitedText(raw: string, options?: CsvParseOptions): CsvParseResult {
  const input = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  if (input.trim().length === 0) {
    return { delimiter: options?.delimiter ?? ',', headers: [], rows: [] };
  }

  const delimiter = options?.delimiter ?? detectDelimiter(input);
  const allRows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === undefined) continue;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"' && field.length === 0) {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(field);
        field = '';
      } else if (ch === '\r') {
        if (input[i + 1] === '\n') i += 1;
        row.push(field);
        allRows.push(row);
        row = [];
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        allRows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    allRows.push(row);
  }

  // Drop trailing empty rows
  while (allRows.length > 0) {
    const lastRow = allRows[allRows.length - 1];
    if (lastRow && lastRow.every((c) => c.trim() === '')) {
      allRows.pop();
    } else {
      break;
    }
  }

  const headerRow = allRows[0];
  if (!headerRow) {
    return { delimiter, headers: [], rows: [] };
  }

  const headers = headerRow.map((h) => h.trim());
  const rows = allRows.slice(1).filter((r) => r.some((cell) => cell.trim() !== ''));
  return { delimiter, headers, rows };
}

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
  },
): CsvImportResult {
  const { deckId, noteType, eventFactory } = options;
  const nowMs = options.nowMs ?? Date.now();
  const parsed = parseDelimitedText(
    csvText,
    options.delimiter ? { delimiter: options.delimiter } : undefined,
  );
  const warnings: CsvImportWarning[] = [];
  const mappedHeaders: Record<string, string> = {};

  if (parsed.headers.length === 0) {
    return { events: [], importedCount: 0, warnings, mappedHeaders };
  }

  const fieldByLookup = new Map<string, string>();
  for (const field of noteType.fields) {
    fieldByLookup.set(field.key.toLowerCase(), field.key);
    fieldByLookup.set(field.label.toLowerCase(), field.key);
  }

  type ColumnRole =
    | { kind: 'field'; fieldKey: string }
    | { kind: 'tags' }
    | { kind: 'card_id' }
    | { kind: 'ignore' };

  const seenNormalized = new Set<string>();
  const columnRoles: ColumnRole[] = parsed.headers.map((header) => {
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

  const events: KnownEvent[] = [];
  const seenSourceKeys = new Set<string>();

  for (let rowIdx = 0; rowIdx < parsed.rows.length; rowIdx++) {
    const row = parsed.rows[rowIdx];
    if (!row) continue;
    const fields: Record<string, string> = {};
    const rawTags: string[] = [];
    let rawSourceKey = '';

    for (let colIdx = 0; colIdx < columnRoles.length; colIdx++) {
      const role = columnRoles[colIdx];
      if (!role) continue;
      const value = (row[colIdx] ?? '').trim();
      if (!value) continue;

      if (role.kind === 'field') {
        fields[role.fieldKey] = options.ankiRuby ? convertAnkiRuby(value) : value;
      } else if (role.kind === 'tags') {
        rawTags.push(...value.split(/[;,]/));
      } else if (role.kind === 'card_id') {
        rawSourceKey = value;
      }
    }

    if (Object.keys(fields).length === 0) {
      warnings.push({
        code: 'empty_row_skipped',
        row: rowIdx + 2,
        message: `Row ${rowIdx + 2} had no mapped field values and was skipped.`,
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
        row: rowIdx + 2,
        message: `Duplicate Card ID "${sourceKey}" on row ${rowIdx + 2}; assigned new ID "${replacement}".`,
      });
      sourceKey = replacement;
    }
    seenSourceKeys.add(sourceKey);

    const noteId = deriveNoteId(deckId, sourceKey);
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
