import { guessLanguageFromText } from '../languages/guess-script.ts';
import { isStrictHttpsUrl } from '@flash/content-schema';
import type { CollectionState, EventFactory } from '../events/replay.ts';
import type { KnownEvent } from '../events/types.ts';
import { deriveNoteId, uuidv7 } from '../ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../model/presets.ts';
import { noteField, ownField } from '../model/note-fields.ts';
import type { Note, NoteType, Provenance, SourceColumnMapping } from '../model/types.ts';
import {
  joinNotes,
  notesFieldKey,
  notesLine,
  resolveSourceColumnMap,
  type ColumnTarget,
} from '../import/column-target.ts';
import { escapeDelimitedCell } from '../import/csv-cell.ts';
import { splitTagCell } from '../import/tag-cell.ts';
import { computeNoteContentHash } from './content-hash.ts';
import { sha256String } from './hash.ts';
import { compareCodeUnits } from '../compare.ts';

export type TabularWarningCode =
  | 'unknown_header'
  | 'duplicate_header'
  | 'duplicate_card_id'
  | 'missing_card_id_readonly'
  | 'empty_row_skipped'
  | 'unsafe_url'
  | 'unsupported_image_formula'
  | 'embedded_in_cell_image'
  | 'duplicate_sort_key'
  | 'missing_sort_key';

export interface TabularImportWarning {
  code: TabularWarningCode;
  message: string;
  row?: number; // 1-based sheet/file row number
  header?: string;
}

export type TabularColumnRole =
  | { kind: 'field'; fieldKey: string; mediaKind?: 'image' | 'audio' }
  | { kind: 'tags' }
  | { kind: 'card_id' }
  /** Appended to the Notes field as `Header: value` (a column mapped to "Add to Notes"). */
  | { kind: 'notes'; header: string }
  | { kind: 'ignore' };

export interface MappedTabularHeaders {
  roles: TabularColumnRole[];
  mappedHeaders: Record<string, string>;
  cardIdColumnIndex: number;
  imageColumnIndices: number[];
  audioColumnIndices: number[];
  warnings: TabularImportWarning[];
}

export interface WriteBackCell {
  rowNumber: number; // 1-based (row 1 = headers, row 2 = first data row)
  colIndex: number; // 0-based
  colLetter: string;
  newCardId: string;
  expectedRowFingerprint: string;
  expectedCurrentCardId: string;
  reason: 'missing' | 'duplicate';
}

export interface WriteBackPlan {
  needsHeaderCell?: {
    rowNumber: 1;
    colIndex: number;
    colLetter: string;
    headerText: 'Card ID';
  };
  cells: WriteBackCell[];
}

export interface SafeWriteBackFilterResult {
  headerUpdate?: { a1: string; value: string };
  safeCells: Array<WriteBackCell & { a1: string }>;
  skippedCells: Array<{
    cell: WriteBackCell;
    reason: 'row_missing' | 'content_changed' | 'card_id_changed';
  }>;
}

export interface ReconciliationCandidateNote {
  noteId: string;
  sortKey: string;
  preview: string;
}

export interface ReconciliationCandidateRow {
  rowNumber: number;
  sortKey: string;
  preview: string;
}

export interface XlsxReconciliationCandidates {
  missingNotes: ReconciliationCandidateNote[];
  addedRows: ReconciliationCandidateRow[];
}

export interface TabularDiffOptions {
  deckId: string;
  noteType: NoteType;
  state: CollectionState;
  eventFactory: EventFactory;
  /** Raw 2D grid where row 0 is headers and rows 1..N are data rows. */
  grid: readonly (readonly string[])[];
  identityMode: 'card_id' | 'sort_key';
  canWriteBack: boolean;
  /** Allow safe relative file paths in image/audio columns (for local folders). */
  allowRelativeMediaPaths?: boolean;
  /** Optional map of normalized relative media path -> `media:<sha256>` URI. */
  mediaPathMap?: Readonly<Record<string, string>>;
  /** Optional 1-based row numbers where an embedded in-cell image was detected. */
  embeddedImageRows?: readonly number[];
  /** Optional `.xlsx` rename reconciliation map: existingNoteId -> new normalized sortKey. */
  renameMap?: Readonly<Record<string, string>>;
  /** Optional provenance override (defaults to `{ source: 'import', reviewed: true }`). */
  provenance?: Provenance;
  /** The mapping saved when the source was linked (`SourceRef.column_map`); see `mapTabularHeaders`. */
  columnMap?: readonly SourceColumnMapping[];
  nowMs?: number;
  /** Optional deterministic ID generator for unit tests (defaults to `uuidv7`). */
  generateCardId?: () => string;
}

export interface TabularDiffResult {
  events: KnownEvent[];
  warnings: TabularImportWarning[];
  mappedHeaders: Record<string, string>;
  writeBackPlan: WriteBackPlan;
  stats: {
    totalRows: number;
    added: number;
    updated: number;
    unchanged: number;
    archived: number;
    restored: number;
    skipped: number;
  };
  /** Mapping of 1-based rowNumber -> noteId (used if raced write-back cells must be dropped). */
  rowToNoteId: Record<number, string>;
  /** Discovered safe relative media paths (for local folders). */
  referencedRelativeMediaPaths: string[];
  /** Non-empty when `.xlsx` (`sort_key`) sees both missing notes and new rows. */
  reconciliationCandidates?: XlsxReconciliationCandidates;
}

/** Converts 0-based column index to A1 spreadsheet column letters (0->A, 25->Z, 26->AA). */
export function columnIndexToA1(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Column index must be a non-negative integer, got ${index}`);
  }
  let n = index + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/**
 * Validates a relative media path inside a linked local folder (§13 — no traversal, no absolute/drive paths).
 */
export function isSafeRelativeMediaPath(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) return false;
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return false; // reject any URL scheme
  const parts = trimmed.split('/');
  for (const part of parts) {
    if (part === '..') return false;
  }
  return true;
}

export interface ParsedImageCell {
  value: string;
  isRelativePath?: boolean;
  warning?: { code: TabularWarningCode; message: string };
}

/**
 * Parses an image cell value from Google Sheets (`valueRenderOption=FORMULA`) or local files (§3.1, §13).
 * Supports `=IMAGE("https://...")`, direct `https://...`, `media:<sha256>`, and optional safe relative paths.
 */
export function parseImageCellValue(
  raw: string,
  options: { allowRelativePath?: boolean; rowNumber?: number } = {},
): ParsedImageCell {
  const trimmed = raw.trim();
  const rowSuffix = options.rowNumber !== undefined ? ` on row ${options.rowNumber}` : '';
  if (!trimmed) return { value: '' };

  if (trimmed.startsWith('=')) {
    // Match =IMAGE("url") or =IMAGE('url', mode, height, width)
    const formulaMatch = /^=\s*image\s*\(\s*(?:"([^"]+)"|'([^']+)')(?:\s*,[\s\S]*)?\)\s*$/i.exec(
      trimmed,
    );
    if (!formulaMatch) {
      return {
        value: '',
        warning: {
          code: 'unsupported_image_formula',
          message: `Unsupported image formula${rowSuffix}: use =IMAGE("https://...") with a literal HTTPS URL.`,
        },
      };
    }
    const url = (formulaMatch[1] ?? formulaMatch[2] ?? '').trim();
    if (!isStrictHttpsUrl(url)) {
      return {
        value: '',
        warning: {
          code: 'unsafe_url',
          message: `Rejected non-HTTPS image URL in =IMAGE()${rowSuffix}. Only https:// URLs are allowed.`,
        },
      };
    }
    return { value: `https://${url.slice(8)}` };
  }

  if (/^media:[0-9a-f]{64}$/i.test(trimmed)) {
    return { value: trimmed.toLowerCase() };
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    if (isStrictHttpsUrl(trimmed)) {
      return { value: `https://${trimmed.slice(8)}` };
    }
    return {
      value: '',
      warning: {
        code: 'unsafe_url',
        message: `Rejected unsafe image URL scheme${rowSuffix}. Only https:// or media: references are allowed.`,
      },
    };
  }

  if (options.allowRelativePath) {
    if (isSafeRelativeMediaPath(trimmed)) {
      return { value: trimmed, isRelativePath: true };
    }
    return {
      value: '',
      warning: {
        code: 'unsafe_url',
        message: `Rejected unsafe relative media path "${trimmed}"${rowSuffix}.`,
      },
    };
  }

  return {
    value: '',
    warning: {
      code: 'embedded_in_cell_image',
      message: `Unrecognized image cell value${rowSuffix}. Use an https:// URL or =IMAGE("https://...") (embedded in-cell images are not readable via API).`,
    },
  };
}

/**
 * Infers the best built-in preset Note Type from column headers when linking a new tabular source.
 */
export function inferPresetNoteTypeId(
  headers: readonly string[],
  fallbackNoteTypeId: string = BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
  rows: readonly (readonly string[])[] = [],
): { noteTypeId: string; language: string } {
  const norms = new Set(headers.map((h) => h.trim().toLowerCase()));
  if (norms.has('eumhun') || norms.has('eumhun (음훈)') || norms.has('character')) {
    return { noteTypeId: BUILTIN_NOTE_TYPE_IDS.HANJA, language: 'ko' };
  }
  if (norms.has('pinyin')) {
    return { noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH, language: 'zh-Hans' };
  }
  if (norms.has('hanja / reading') || norms.has('hanja')) {
    return { noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, language: 'ko' };
  }
  if (norms.has('grammar point') || norms.has('pattern') || norms.has('explanation')) {
    return { noteTypeId: BUILTIN_NOTE_TYPE_IDS.GRAMMAR, language: 'ko' };
  }
  if (norms.has('sentence') || norms.has('translation')) {
    // The Sentence type fits any language, so the sentences themselves say which one (C8).
    const col = headers.findIndex((h) => h.trim().toLowerCase() === 'sentence');
    const sample = col >= 0 ? rows.map((r) => r[col] ?? '') : [];
    return {
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.SENTENCE,
      language: guessLanguageFromText(sample) ?? 'en',
    };
  }
  if (norms.has('reading')) {
    return { noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA, language: 'ja' };
  }
  const langMap: Record<string, string> = {
    [BUILTIN_NOTE_TYPE_IDS.VOCAB_JA]: 'ja',
    [BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH]: 'zh-Hans',
    [BUILTIN_NOTE_TYPE_IDS.VOCAB_KO]: 'ko',
    [BUILTIN_NOTE_TYPE_IDS.HANJA]: 'ko',
    [BUILTIN_NOTE_TYPE_IDS.GRAMMAR]: 'ko',
    [BUILTIN_NOTE_TYPE_IDS.SENTENCE]: 'en',
    [BUILTIN_NOTE_TYPE_IDS.CLOZE]: 'ja',
  };
  return {
    noteTypeId: fallbackNoteTypeId,
    language: langMap[fallbackNoteTypeId] ?? 'en',
  };
}

function fieldRole(
  fieldKey: string,
  noteType: NoteType,
  colIdx: number,
  imageColumnIndices: number[],
  audioColumnIndices: number[],
): TabularColumnRole {
  const kind = noteType.fields.find((f) => f.key === fieldKey)?.kind;
  if (kind === 'image') {
    imageColumnIndices.push(colIdx);
    return { kind: 'field', fieldKey, mediaKind: 'image' };
  }
  if (kind === 'audio') {
    audioColumnIndices.push(colIdx);
    return { kind: 'field', fieldKey, mediaKind: 'audio' };
  }
  return { kind: 'field', fieldKey };
}

/**
 * Matches tabular headers to Note Type fields by name (never position alone, except Flashcards Deluxe `Text 1..N`).
 * A saved `columnMap` (the Bring my cards mapping step) decides first for every header it lists.
 */
export function mapTabularHeaders(
  headers: readonly string[],
  noteType: NoteType,
  columnMap?: readonly SourceColumnMapping[],
): MappedTabularHeaders {
  const explicit: (ColumnTarget | undefined)[] = resolveSourceColumnMap(
    headers,
    columnMap,
    noteType,
  );
  const notesKey = notesFieldKey(noteType);
  const warnings: TabularImportWarning[] = [];
  const mappedHeaders: Record<string, string> = {};
  const fieldByLookup = new Map<string, { key: string; kind: string }>();
  let imageFieldKey: string | undefined;
  let audioFieldKey: string | undefined;

  for (const field of noteType.fields) {
    fieldByLookup.set(field.key.toLowerCase(), { key: field.key, kind: field.kind });
    fieldByLookup.set(field.label.toLowerCase(), { key: field.key, kind: field.kind });
    if (field.kind === 'image' && !imageFieldKey) imageFieldKey = field.key;
    if (field.kind === 'audio' && !audioFieldKey) audioFieldKey = field.key;
  }

  let cardIdColumnIndex = -1;
  const imageColumnIndices: number[] = [];
  const audioColumnIndices: number[] = [];
  const seenNormalized = new Set<string>();

  const roles: TabularColumnRole[] = headers.map((rawHeader, colIdx) => {
    const header = rawHeader.trim();
    const norm = header.toLowerCase();
    if (!norm) return { kind: 'ignore' };

    const saved = explicit[colIdx];
    if (saved) {
      if (saved.kind === 'card_id' && cardIdColumnIndex === -1) {
        cardIdColumnIndex = colIdx;
        mappedHeaders[header] = 'source_key';
        return { kind: 'card_id' };
      }
      if (saved.kind === 'field') {
        mappedHeaders[header] = saved.fieldKey;
        return fieldRole(saved.fieldKey, noteType, colIdx, imageColumnIndices, audioColumnIndices);
      }
      if (saved.kind === 'tags') {
        mappedHeaders[header] = 'tags';
        return { kind: 'tags' };
      }
      if (saved.kind === 'notes' && notesKey) {
        mappedHeaders[header] = notesKey;
        return { kind: 'notes', header };
      }
      return { kind: 'ignore' };
    }

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
      if (cardIdColumnIndex === -1) {
        cardIdColumnIndex = colIdx;
        mappedHeaders[header] = 'source_key';
        return { kind: 'card_id' };
      }
      warnings.push({
        code: 'duplicate_header',
        header,
        message: `Duplicate Card ID column "${header}" ignored.`,
      });
      return { kind: 'ignore' };
    }

    if (norm === 'tags' || norm === 'tag' || /^category\s*\d*$/.test(norm)) {
      mappedHeaders[header] = 'tags';
      return { kind: 'tags' };
    }

    const direct = fieldByLookup.get(norm);
    if (direct) {
      mappedHeaders[header] = direct.key;
      if (direct.kind === 'image') {
        imageColumnIndices.push(colIdx);
        return { kind: 'field', fieldKey: direct.key, mediaKind: 'image' };
      }
      if (direct.kind === 'audio') {
        audioColumnIndices.push(colIdx);
        return { kind: 'field', fieldKey: direct.key, mediaKind: 'audio' };
      }
      return { kind: 'field', fieldKey: direct.key };
    }

    // Image / Picture columns (Google Sheets & Flashcards Deluxe)
    if (norm === 'image' || /^picture\s*1?$/.test(norm)) {
      const targetKey = imageFieldKey ?? 'image';
      mappedHeaders[header] = targetKey;
      imageColumnIndices.push(colIdx);
      return { kind: 'field', fieldKey: targetKey, mediaKind: 'image' };
    }

    // Audio / Sound columns (Flashcards Deluxe)
    if (norm === 'audio' || /^sound\s*1?$/.test(norm)) {
      const targetKey = audioFieldKey ?? 'audio';
      mappedHeaders[header] = targetKey;
      audioColumnIndices.push(colIdx);
      return { kind: 'field', fieldKey: targetKey, mediaKind: 'audio' };
    }

    // Flashcards Deluxe compatibility: "Text 1", "Text 2", ...
    const textMatch = /^text\s*(\d+)$/.exec(norm);
    if (textMatch) {
      const idx = Number(textMatch[1]) - 1;
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

  return {
    roles,
    mappedHeaders,
    cardIdColumnIndex,
    imageColumnIndices,
    audioColumnIndices,
    warnings,
  };
}

/** Computes a stable row content fingerprint (all columns except the Card ID column) for race-safe write-back. */
export function computeTabularRowFingerprint(
  row: readonly string[],
  roles: readonly TabularColumnRole[],
): string {
  const parts: string[] = [];
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    if (!role || role.kind === 'card_id') continue;
    const val = (row[i] ?? '').trim();
    parts.push(`${i}:${val.length}:${val}`);
  }
  return sha256String(parts.join('\u001f'));
}

function trimTrailingEmptyRows(grid: readonly (readonly string[])[]): (readonly string[])[] {
  const copy = [...grid];
  while (copy.length > 0) {
    const last = copy[copy.length - 1];
    if (last && last.every((cell) => (cell ?? '').trim() === '')) {
      copy.pop();
    } else {
      break;
    }
  }
  return copy;
}

function normalizeSortKeyValue(val: string): string {
  return val.trim().normalize('NFC');
}

function getSortKeyField(noteType: NoteType): string {
  return noteType.fields.find((f) => f.sortKey)?.key ?? noteType.fields[0]?.key ?? 'word';
}

function buildRowPreview(fields: Readonly<Record<string, string>>, sortKeyField: string): string {
  const primary = ownField(fields, sortKeyField) ?? '';
  const secondary = Object.entries(fields)
    .filter(([k, v]) => k !== sortKeyField && v.trim().length > 0)
    .slice(0, 2)
    .map(([, v]) => v.trim())
    .join(' · ');
  return secondary ? `${primary} — ${secondary}` : primary;
}

/**
 * Pure tabular diff engine (§3.1 & §3.2):
 * - Matches headers by name, parses `=IMAGE(url)`, flags embedded images & unknown/duplicate headers
 * - Diffs against existing deck notes by content hash (emitting only changed `NoteUpserted`,
 *   `NoteArchived` for deleted rows, `NoteRestored` when rows reappear preserving full reviews)
 * - Produces a race-safe `WriteBackPlan` for missing/duplicate `Card ID`s
 * - Supports `.xlsx` `sortKey` matching with rename reconciliation candidates
 */
export function diffTabularSource(options: TabularDiffOptions): TabularDiffResult {
  const {
    deckId,
    noteType,
    state,
    eventFactory,
    identityMode,
    canWriteBack,
    allowRelativeMediaPaths = false,
    mediaPathMap,
    embeddedImageRows = [],
    renameMap,
    provenance = { source: 'import', reviewed: true },
  } = options;
  const nowMs = options.nowMs ?? Date.now();
  const generateCardId = options.generateCardId ?? (() => uuidv7(nowMs));

  const trimmedGrid = trimTrailingEmptyRows(options.grid);
  const headerRow = trimmedGrid[0];
  if (!headerRow || headerRow.length === 0) {
    return {
      events: [],
      warnings: [],
      mappedHeaders: {},
      writeBackPlan: { cells: [] },
      stats: {
        totalRows: 0,
        added: 0,
        updated: 0,
        unchanged: 0,
        archived: 0,
        restored: 0,
        skipped: 0,
      },
      rowToNoteId: {},
      referencedRelativeMediaPaths: [],
    };
  }

  const headerMap = mapTabularHeaders(headerRow, noteType, options.columnMap);
  const notesKey = notesFieldKey(noteType);
  const warnings: TabularImportWarning[] = [...headerMap.warnings];
  const embeddedSet = new Set(embeddedImageRows);
  const referencedRelativeSet = new Set<string>();

  // Determine where Card IDs would be written if needed
  const hasCardIdCol = headerMap.cardIdColumnIndex >= 0;
  const targetCardIdColIndex = hasCardIdCol ? headerMap.cardIdColumnIndex : headerRow.length;
  const targetCardIdColLetter = columnIndexToA1(targetCardIdColIndex);

  const writeBackPlan: WriteBackPlan = { cells: [] };
  const ensureHeaderPlanned = (): void => {
    if (!hasCardIdCol && !writeBackPlan.needsHeaderCell) {
      writeBackPlan.needsHeaderCell = {
        rowNumber: 1,
        colIndex: targetCardIdColIndex,
        colLetter: targetCardIdColLetter,
        headerText: 'Card ID',
      };
    }
  };

  // Index existing notes in this deck
  const existingDeckNotes: Note[] = [];
  const existingById = new Map<string, Note>();
  const existingBySourceKey = new Map<string, Note>();
  const sortKeyField = getSortKeyField(noteType);
  const existingBySortKey = new Map<string, Note>();

  for (const note of state.notes.values()) {
    if (note.deck_id !== deckId) continue;
    existingDeckNotes.push(note);
    existingById.set(note.id, note);
    if (note.source_key) {
      existingBySourceKey.set(note.source_key, note);
    }
    const sk = normalizeSortKeyValue(noteField(note, sortKeyField) ?? note.source_key ?? '');
    if (sk) {
      const prev = existingBySortKey.get(sk);
      // Prefer active note over archived note if both somehow share a sortKey
      if (!prev || (prev.archived && !note.archived)) {
        existingBySortKey.set(sk, note);
      }
    }
  }

  // Reverse map for `.xlsx` rename reconciliation: normalizedNewSortKey -> existingNoteId
  const renamedSortKeyToNoteId = new Map<string, string>();
  if (renameMap) {
    for (const [oldNoteId, newKey] of Object.entries(renameMap)) {
      const normKey = normalizeSortKeyValue(newKey);
      if (normKey && existingById.has(oldNoteId)) {
        renamedSortKeyToNoteId.set(normKey, oldNoteId);
      }
    }
  }

  const events: KnownEvent[] = [];
  const seenNoteIds = new Set<string>();
  const seenSourceKeys = new Set<string>();
  const rowToNoteId: Record<number, string> = {};
  const newlyAddedRowsForReconcile: ReconciliationCandidateRow[] = [];

  const stats = {
    totalRows: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    archived: 0,
    restored: 0,
    skipped: 0,
  };

  for (let gridIdx = 1; gridIdx < trimmedGrid.length; gridIdx++) {
    const row = trimmedGrid[gridIdx];
    const rowNumber = gridIdx + 1; // 1-based sheet row
    if (!row || row.every((c) => (c ?? '').trim() === '')) {
      continue;
    }
    stats.totalRows += 1;

    if (embeddedSet.has(rowNumber)) {
      warnings.push({
        code: 'embedded_in_cell_image',
        row: rowNumber,
        message: `Row ${rowNumber} contains an embedded in-cell image that cannot be read via API; use =IMAGE("https://...") or an HTTPS URL instead.`,
      });
    }

    const fields: Record<string, string> = {};
    const tagSet = new Set<string>();
    const notes: string[] = [];
    let rawCardId = '';

    for (let colIdx = 0; colIdx < headerMap.roles.length; colIdx++) {
      const role = headerMap.roles[colIdx];
      if (!role || role.kind === 'ignore') continue;
      const rawCell = (row[colIdx] ?? '').trim();
      if (!rawCell) continue;

      if (role.kind === 'card_id') {
        rawCardId = rawCell;
      } else if (role.kind === 'notes') {
        notes.push(notesLine(role.header, colIdx, rawCell));
      } else if (role.kind === 'tags') {
        for (const part of splitTagCell(rawCell)) {
          const t = part.normalize('NFC').trim();
          if (t) tagSet.add(t);
        }
      } else if (role.kind === 'field') {
        if (role.mediaKind === 'image') {
          const parsedImg = parseImageCellValue(rawCell, {
            allowRelativePath: allowRelativeMediaPaths,
            rowNumber,
          });
          if (parsedImg.warning) {
            warnings.push({
              code: parsedImg.warning.code,
              row: rowNumber,
              message: parsedImg.warning.message,
            });
          }
          if (parsedImg.value) {
            if (parsedImg.isRelativePath) {
              referencedRelativeSet.add(parsedImg.value);
            }
            const mapped = mediaPathMap?.[parsedImg.value];
            fields[role.fieldKey] = mapped ?? parsedImg.value;
          }
        } else if (role.mediaKind === 'audio') {
          if (/^media:[0-9a-f]{64}$/i.test(rawCell)) {
            fields[role.fieldKey] = rawCell.toLowerCase();
          } else if (isStrictHttpsUrl(rawCell)) {
            const normalizedUrl = `https://${rawCell.slice(8)}`;
            const mapped = mediaPathMap?.[normalizedUrl];
            fields[role.fieldKey] = mapped ?? normalizedUrl;
          } else if (allowRelativeMediaPaths && isSafeRelativeMediaPath(rawCell)) {
            referencedRelativeSet.add(rawCell);
            const mapped = mediaPathMap?.[rawCell];
            fields[role.fieldKey] = mapped ?? rawCell;
          } else {
            warnings.push({
              code: 'unsafe_url',
              row: rowNumber,
              message: `Rejected unsafe audio reference on row ${rowNumber}.`,
            });
          }
        } else {
          const prev = ownField(fields, role.fieldKey);
          // Several columns may go to Notes (the mapping step allows it for Notes only).
          fields[role.fieldKey] =
            prev && role.fieldKey === notesKey ? joinNotes(prev, [rawCell]) : rawCell;
        }
      }
    }

    if (notesKey && notes.length > 0)
      fields[notesKey] = joinNotes(ownField(fields, notesKey), notes);

    if (Object.keys(fields).length === 0) {
      stats.skipped += 1;
      warnings.push({
        code: 'empty_row_skipped',
        row: rowNumber,
        message: `Row ${rowNumber} had no mapped field values and was skipped.`,
      });
      continue;
    }

    const tags = [...tagSet].sort(compareCodeUnits);
    const fingerprint = computeTabularRowFingerprint(row, headerMap.roles);

    let noteId: string;
    let sourceKey: string;
    let matchedExisting: Note | undefined;

    if (identityMode === 'card_id') {
      if (!rawCardId) {
        if (!canWriteBack) {
          stats.skipped += 1;
          warnings.push({
            code: 'missing_card_id_readonly',
            row: rowNumber,
            message: `Row ${rowNumber} is missing a Card ID on a read-only source. Ask the owner to sync once so Card IDs are populated.`,
          });
          continue;
        }
        const assigned = generateCardId();
        ensureHeaderPlanned();
        writeBackPlan.cells.push({
          rowNumber,
          colIndex: targetCardIdColIndex,
          colLetter: targetCardIdColLetter,
          newCardId: assigned,
          expectedRowFingerprint: fingerprint,
          expectedCurrentCardId: '',
          reason: 'missing',
        });
        sourceKey = assigned;
      } else if (seenSourceKeys.has(rawCardId)) {
        if (canWriteBack) {
          const replacement = generateCardId();
          ensureHeaderPlanned();
          writeBackPlan.cells.push({
            rowNumber,
            colIndex: targetCardIdColIndex,
            colLetter: targetCardIdColLetter,
            newCardId: replacement,
            expectedRowFingerprint: fingerprint,
            expectedCurrentCardId: rawCardId,
            reason: 'duplicate',
          });
          warnings.push({
            code: 'duplicate_card_id',
            row: rowNumber,
            message: `Duplicate Card ID "${rawCardId}" on row ${rowNumber}; assigned new ID "${replacement}".`,
          });
          sourceKey = replacement;
        } else {
          const disambiguated = `${rawCardId}#dup-${rowNumber}`;
          warnings.push({
            code: 'duplicate_card_id',
            row: rowNumber,
            message: `Duplicate Card ID "${rawCardId}" on read-only row ${rowNumber}; disambiguated locally as "${disambiguated}".`,
          });
          sourceKey = disambiguated;
        }
      } else {
        sourceKey = rawCardId;
      }

      seenSourceKeys.add(sourceKey);
      matchedExisting = existingBySourceKey.get(sourceKey);
      noteId = matchedExisting ? matchedExisting.id : deriveNoteId(deckId, sourceKey);
      if (!matchedExisting) {
        matchedExisting = existingById.get(noteId);
      }
    } else {
      // `.xlsx` read-only `sort_key` identity mode
      const rawSortKey = ownField(fields, sortKeyField) ?? '';
      const normSortKey = normalizeSortKeyValue(rawSortKey);
      if (!normSortKey) {
        stats.skipped += 1;
        warnings.push({
          code: 'missing_sort_key',
          row: rowNumber,
          message: `Row ${rowNumber} is missing required sort key field "${sortKeyField}" and was skipped.`,
        });
        continue;
      }

      if (seenSourceKeys.has(normSortKey)) {
        const disambiguated = `${normSortKey}#dup-${rowNumber}`;
        warnings.push({
          code: 'duplicate_sort_key',
          row: rowNumber,
          message: `Duplicate sort key "${normSortKey}" on row ${rowNumber}; disambiguated as "${disambiguated}".`,
        });
        sourceKey = disambiguated;
      } else {
        sourceKey = normSortKey;
      }
      seenSourceKeys.add(sourceKey);

      const reconciledNoteId = renamedSortKeyToNoteId.get(sourceKey);
      if (reconciledNoteId) {
        matchedExisting = existingById.get(reconciledNoteId);
      } else {
        matchedExisting = existingBySourceKey.get(sourceKey) ?? existingBySortKey.get(sourceKey);
      }

      if (matchedExisting && seenNoteIds.has(matchedExisting.id)) {
        // Avoid colliding with an already matched note
        matchedExisting = undefined;
      }

      noteId = matchedExisting ? matchedExisting.id : deriveNoteId(deckId, `sortkey:${sourceKey}`);
      if (!matchedExisting) {
        newlyAddedRowsForReconcile.push({
          rowNumber,
          sortKey: sourceKey,
          preview: buildRowPreview(fields, sortKeyField),
        });
      }
    }

    seenNoteIds.add(noteId);
    rowToNoteId[rowNumber] = noteId;

    // Emit diffed events
    if (!matchedExisting) {
      stats.added += 1;
      events.push(
        eventFactory.create(
          'NoteUpserted',
          {
            note_id: noteId,
            deck_id: deckId,
            source_key: sourceKey,
            fields,
            tags,
            provenance,
            created_order: gridIdx - 1,
          },
          nowMs,
        ),
      );
    } else {
      // Build full field patch including clearing any previously populated mapped fields that are now empty
      const nextFields: Record<string, string> = {};
      for (const key of Object.keys(matchedExisting.fields)) {
        nextFields[key] = ownField(fields, key) ?? '';
      }
      for (const [k, v] of Object.entries(fields)) {
        nextFields[k] = v;
      }

      const prevHash = computeNoteContentHash(matchedExisting.fields, matchedExisting.tags);
      const nextHash = computeNoteContentHash(nextFields, tags);
      const contentChanged = prevHash !== nextHash || matchedExisting.source_key !== sourceKey;

      if (matchedExisting.archived) {
        stats.restored += 1;
        events.push(eventFactory.create('NoteRestored', { note_id: noteId }, nowMs));
        if (contentChanged) {
          events.push(
            eventFactory.create(
              'NoteUpserted',
              {
                note_id: noteId,
                deck_id: deckId,
                source_key: sourceKey,
                fields: nextFields,
                tags,
                provenance,
              },
              nowMs,
            ),
          );
        }
      } else if (contentChanged) {
        stats.updated += 1;
        events.push(
          eventFactory.create(
            'NoteUpserted',
            {
              note_id: noteId,
              deck_id: deckId,
              source_key: sourceKey,
              fields: nextFields,
              tags,
              provenance,
            },
            nowMs,
          ),
        );
      } else {
        stats.unchanged += 1;
      }
    }
  }

  // Soft-archive active notes in this deck that are no longer present in the source (§3.1)
  const missingActiveNotes: ReconciliationCandidateNote[] = [];
  for (const existing of existingDeckNotes) {
    if (!existing.archived && !seenNoteIds.has(existing.id)) {
      stats.archived += 1;
      events.push(eventFactory.create('NoteArchived', { note_id: existing.id }, nowMs));
      if (identityMode === 'sort_key') {
        missingActiveNotes.push({
          noteId: existing.id,
          sortKey: normalizeSortKeyValue(noteField(existing, sortKeyField) ?? existing.source_key),
          preview: buildRowPreview(existing.fields, sortKeyField),
        });
      }
    }
  }

  const reconciliationCandidates =
    identityMode === 'sort_key' &&
    missingActiveNotes.length > 0 &&
    newlyAddedRowsForReconcile.length > 0
      ? {
          missingNotes: missingActiveNotes,
          addedRows: newlyAddedRowsForReconcile,
        }
      : undefined;

  return {
    events,
    warnings,
    mappedHeaders: headerMap.mappedHeaders,
    writeBackPlan,
    stats,
    rowToNoteId,
    referencedRelativeMediaPaths: [...referencedRelativeSet].sort(),
    ...(reconciliationCandidates !== undefined ? { reconciliationCandidates } : {}),
  };
}

/**
 * Race-safe `Card ID` write-back guard (§3.1):
 * Re-checks every planned write-back row against a freshly re-read grid right before `batchUpdate`.
 * Only cells whose row content fingerprint AND current Card ID cell match expectations are approved.
 */
export function filterSafeWriteBackCells(
  plan: WriteBackPlan,
  reReadGrid: readonly (readonly string[])[],
  noteType: NoteType,
  columnMap?: readonly SourceColumnMapping[],
): SafeWriteBackFilterResult {
  const headerRow = reReadGrid[0] ?? [];
  const headerMap = mapTabularHeaders(headerRow, noteType, columnMap);

  const safeCells: Array<WriteBackCell & { a1: string }> = [];
  const skippedCells: SafeWriteBackFilterResult['skippedCells'] = [];

  // Re-verify header cell if we planned to add a new "Card ID" column
  let headerUpdate: { a1: string; value: string } | undefined;
  let effectiveCardIdColIndex = headerMap.cardIdColumnIndex;

  if (plan.needsHeaderCell) {
    if (headerMap.cardIdColumnIndex >= 0) {
      // Another device added the Card ID column in the meantime; check that column instead
      effectiveCardIdColIndex = headerMap.cardIdColumnIndex;
    } else if (plan.needsHeaderCell.colIndex >= headerRow.length) {
      effectiveCardIdColIndex = plan.needsHeaderCell.colIndex;
      headerUpdate = {
        a1: `${plan.needsHeaderCell.colLetter}1`,
        value: plan.needsHeaderCell.headerText,
      };
    } else {
      // Column count shifted unexpectedly; abort all writes so next pull stays clean
      return {
        safeCells: [],
        skippedCells: plan.cells.map((cell) => ({ cell, reason: 'content_changed' })),
      };
    }
  }

  for (const cell of plan.cells) {
    const row = reReadGrid[cell.rowNumber - 1];
    if (!row) {
      skippedCells.push({ cell, reason: 'row_missing' });
      continue;
    }

    const currentFingerprint = computeTabularRowFingerprint(row, headerMap.roles);
    if (currentFingerprint !== cell.expectedRowFingerprint) {
      skippedCells.push({ cell, reason: 'content_changed' });
      continue;
    }

    const actualCardId =
      effectiveCardIdColIndex >= 0 ? (row[effectiveCardIdColIndex] ?? '').trim() : '';
    if (actualCardId !== cell.expectedCurrentCardId) {
      skippedCells.push({ cell, reason: 'card_id_changed' });
      continue;
    }

    const colLetter =
      effectiveCardIdColIndex >= 0 ? columnIndexToA1(effectiveCardIdColIndex) : cell.colLetter;
    safeCells.push({
      ...cell,
      colIndex: effectiveCardIdColIndex >= 0 ? effectiveCardIdColIndex : cell.colIndex,
      colLetter,
      a1: `${colLetter}${cell.rowNumber}`,
    });
  }

  return {
    ...(headerUpdate !== undefined && safeCells.length > 0 ? { headerUpdate } : {}),
    safeCells,
    skippedCells,
  };
}

/**
 * Applies approved `Card ID` write-back cells to a 2D grid and serializes back to RFC 4180 CSV/TSV
 * for local folder `.csv`/`.tsv` write-back (§3.2).
 */
export function applyCardIdsToGridAndSerialize(
  grid: readonly (readonly string[])[],
  delimiter: ',' | '\t',
  writeBack: SafeWriteBackFilterResult,
  plan: WriteBackPlan,
): string {
  const mutable: string[][] = grid.map((row) => [...row]);
  if (mutable.length === 0) return '';

  const headerRow = mutable[0];
  if (!headerRow) return '';

  if (writeBack.headerUpdate && plan.needsHeaderCell) {
    const idx = plan.needsHeaderCell.colIndex;
    while (headerRow.length <= idx) headerRow.push('');
    headerRow[idx] = plan.needsHeaderCell.headerText;
  }

  for (const cell of writeBack.safeCells) {
    const row = mutable[cell.rowNumber - 1];
    if (!row) continue;
    while (row.length <= cell.colIndex) row.push('');
    row[cell.colIndex] = cell.newCardId;
  }

  // A reduce, not `Math.max(...)`: spreading ~150k+ rows overflows the stack (C16).
  const colCount = mutable.reduce((max, r) => Math.max(max, r.length), 0);
  return (
    mutable
      .map((row) => {
        const padded = [...row];
        while (padded.length < colCount) padded.push('');
        // No `quoteOuterSpace` here, unlike `exportCsv`. The grid carries no quote flags, so a
        // cell padded with spaces can't be told from one that was written quoted.
        // Quoting padded cells would make the user's unquoted `  word ` read back with its spaces
        // (a quoted cell keeps them, C17), changing cells that were trimmed before the write-back.
        return padded.map((c) => escapeDelimitedCell(c ?? '', delimiter)).join(delimiter);
      })
      .join('\n') + '\n'
  );
}
