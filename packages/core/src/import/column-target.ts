import type { NoteType, SourceColumnMapping } from '../model/types.ts';

/**
 * Where one column of an imported table goes (the Bring my cards mapping step). Shared by the
 * CSV/TSV importer and the linked-Sheets diff; the guess itself lives in `column-mapping.ts`.
 */
export type ColumnTarget =
  | { kind: 'field'; fieldKey: string }
  | { kind: 'tags' }
  | { kind: 'card_id' }
  /** Appended to the note type's Notes field as a `Header: value` line, so nothing is lost. */
  | { kind: 'notes' }
  | { kind: 'ignore' };

/** The note type's Notes field (key or label `notes`), if it has one. */
export function notesFieldKey(noteType: NoteType): string | undefined {
  const byKey = noteType.fields.find((f) => f.key.toLowerCase() === 'notes');
  if (byKey) return byKey.key;
  return noteType.fields.find((f) => f.label.trim().toLowerCase() === 'notes')?.key;
}

/** `Column 3` for a column with no header text. */
export function columnDisplayName(header: string, index: number): string {
  const trimmed = header.trim();
  return trimmed || `Column ${index + 1}`;
}

/** One `Header: value` line for the Notes field. */
export function notesLine(header: string, index: number, value: string): string {
  return `${columnDisplayName(header, index)}: ${value}`;
}

/** Joins field text with the `Header: value` lines of columns sent to Notes. */
export function joinNotes(existing: string | undefined, lines: readonly string[]): string {
  return [existing ?? '', ...lines].filter((part) => part.trim() !== '').join('\n');
}

/** `field:<key>`, `tags`, `card_id`, `notes` or `ignore` (the stored form, see `SourceRef`). */
export function encodeColumnTarget(target: ColumnTarget): string {
  return target.kind === 'field' ? `field:${target.fieldKey}` : target.kind;
}

/**
 * Reads a stored target back for `noteType`. Returns `undefined` when it names a field the note
 * type doesn't have, or Notes on a note type without a Notes field, so the caller can fall back.
 */
export function decodeColumnTarget(raw: string, noteType: NoteType): ColumnTarget | undefined {
  if (raw === 'tags' || raw === 'card_id' || raw === 'ignore') return { kind: raw };
  if (raw === 'notes') return notesFieldKey(noteType) ? { kind: 'notes' } : undefined;
  if (raw.startsWith('field:')) {
    const fieldKey = raw.slice('field:'.length);
    return noteType.fields.some((f) => f.key === fieldKey)
      ? { kind: 'field', fieldKey }
      : undefined;
  }
  return undefined;
}

function headerKey(header: string): string {
  return header.normalize('NFC').trim().toLowerCase();
}

/** Stores a mapping by header name (blank headers can't be matched later, so they are left out). */
export function toSourceColumnMap(
  headers: readonly string[],
  targets: readonly ColumnTarget[],
): SourceColumnMapping[] {
  const out: SourceColumnMapping[] = [];
  headers.forEach((header, index) => {
    const target = targets[index];
    if (!target || header.trim() === '') return;
    out.push({ header: header.trim(), target: encodeColumnTarget(target) });
  });
  return out;
}

/**
 * Applies a saved mapping to a header row: each header takes the next unused entry with the same
 * name (case- and NFC-insensitive), so repeated headers keep their order. Columns with no usable
 * entry are `undefined`.
 */
export function resolveSourceColumnMap(
  headers: readonly string[],
  columnMap: readonly SourceColumnMapping[] | undefined,
  noteType: NoteType,
): (ColumnTarget | undefined)[] {
  if (!columnMap || columnMap.length === 0) return headers.map(() => undefined);
  const used = new Set<number>();
  return headers.map((header) => {
    const key = headerKey(header);
    if (!key) return undefined;
    const at = columnMap.findIndex((m, i) => !used.has(i) && headerKey(m.header) === key);
    if (at === -1) return undefined;
    used.add(at);
    const entry = columnMap[at];
    return entry ? decodeColumnTarget(entry.target, noteType) : undefined;
  });
}
