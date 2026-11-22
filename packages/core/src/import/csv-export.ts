import type { CollectionState } from '../events/replay.ts';
import type { Note, NoteType } from '../model/types.ts';
import { normalizeTagList } from '../tags/index.ts';

export interface CsvExportOptions {
  deckId: string;
  /** Export only these notes (still limited to `deckId`). Omitted = every note of the deck. */
  noteIds?: Iterable<string>;
  /** Include archived notes (default `false`, like `.flashpkg` export). */
  includeArchived?: boolean;
  delimiter?: ',' | '\t';
  /** Prefix a UTF-8 BOM so Excel opens Hangul / CJK text correctly (default `true`). */
  bom?: boolean;
}

export interface CsvExportResult {
  text: string;
  headers: string[];
  noteCount: number;
}

/** Header names `buildEventsFromCsv` gives a special meaning to (case-insensitive). */
function isReservedHeader(lower: string): boolean {
  return (
    lower === 'card id' ||
    lower === 'card_id' ||
    lower === 'id' ||
    lower === 'source_key' ||
    lower === 'tags' ||
    lower === 'tag' ||
    /^category\s*\d*$/.test(lower)
  );
}

/**
 * Column header for each Note Type field, chosen so `buildEventsFromCsv` maps it back to the
 * same field: the label, else the key, else Flashcards Deluxe positional `Text N`.
 */
function fieldHeaders(noteType: NoteType): string[] {
  const used = new Set<string>();
  // Labels / keys of other fields win over a `Text N` lookup in the importer, so keep them unique.
  const lookups = new Map<string, number>();
  noteType.fields.forEach((f, i) => {
    for (const name of [f.key.toLowerCase(), f.label.toLowerCase()]) {
      if (!lookups.has(name)) lookups.set(name, i);
    }
  });
  return noteType.fields.map((field, i) => {
    for (const candidate of [field.label.trim(), field.key.trim()]) {
      const lower = candidate.toLowerCase();
      if (!candidate || isReservedHeader(lower) || used.has(lower)) continue;
      if (lookups.get(lower) !== i) continue;
      used.add(lower);
      return candidate;
    }
    const positional = `Text ${i + 1}`;
    used.add(positional.toLowerCase());
    return positional;
  });
}

function escapeCell(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || /[\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Exports one deck as Flashcards Deluxe-style CSV / TSV that `buildEventsFromCsv` reads back
 * losslessly: `Card ID` (the note's source key), one column per Note Type field, then
 * `Category 1..N` with one category (note tag) per column. Rows follow the deck's note order.
 */
export function exportCsv(state: CollectionState, options: CsvExportOptions): CsvExportResult {
  const delimiter = options.delimiter ?? ',';
  const deck = state.decks.get(options.deckId);
  const noteType = deck ? state.noteTypes.get(deck.note_type_id) : undefined;
  const wanted = options.noteIds ? new Set(options.noteIds) : null;

  const notes: Note[] = [];
  for (const note of state.notes.values()) {
    if (note.deck_id !== options.deckId) continue;
    if (note.archived && !options.includeArchived) continue;
    if (wanted && !wanted.has(note.id)) continue;
    notes.push(note);
  }
  notes.sort((a, b) => a.created_order - b.created_order || (a.id < b.id ? -1 : 1));

  const fields = noteType?.fields ?? [];
  const tagLists = notes.map((n) => normalizeTagList(n.tags));
  const categoryColumns = Math.max(1, ...tagLists.map((t) => t.length));
  const headers = [
    'Card ID',
    ...(noteType ? fieldHeaders(noteType) : []),
    ...Array.from({ length: categoryColumns }, (_, i) => `Category ${i + 1}`),
  ];

  const lines = [headers.map((h) => escapeCell(h, delimiter)).join(delimiter)];
  notes.forEach((note, idx) => {
    const tags = tagLists[idx] ?? [];
    const cells = [
      note.source_key || note.id,
      ...fields.map((f) => note.fields[f.key] ?? ''),
      ...Array.from({ length: categoryColumns }, (_, i) => tags[i] ?? ''),
    ];
    lines.push(cells.map((c) => escapeCell(c, delimiter)).join(delimiter));
  });

  const body = lines.join('\r\n') + '\r\n';
  return {
    text: (options.bom === false ? '' : '﻿') + body,
    headers,
    noteCount: notes.length,
  };
}
