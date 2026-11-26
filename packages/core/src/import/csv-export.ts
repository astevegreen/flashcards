import type { CollectionState } from '../events/replay.ts';
import type { Note, NoteType } from '../model/types.ts';
import { stripRichText as stripRichTextMarkup } from '../parsers/rich-text.ts';
import { normalizeTagList } from '../tags/index.ts';
import { escapeDelimitedCell } from './csv-cell.ts';
import { uniqueRecordIds } from './record-ids.ts';

export interface CsvExportOptions {
  deckId: string;
  /** Export only these notes (still limited to `deckId`). Omitted = every note of the deck. */
  noteIds?: Iterable<string>;
  /** Include archived notes (default `false`, like `.flashpkg` export). */
  includeArchived?: boolean;
  delimiter?: ',' | '\t';
  /** Prefix a UTF-8 BOM so Excel opens Hangul / CJK text correctly (default `true`). */
  bom?: boolean;
  /**
   * Strip the field editor's rich-text markup (`{b:…}`, `{red:…}`) from the cells (default
   * `false`: kept as typed, like ruby and cloze, so the file imports back into this app intact).
   * Strip it for a copy that other apps read, where the braces would show.
   */
  stripRichText?: boolean;
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
  return escapeDelimitedCell(value, delimiter, { quoteOuterSpace: true });
}

/**
 * Import splits a category cell on `,` and `;`, so a tag holding one (from `.flashpkg` or Anki)
 * is written as `\,` or `\;`, and a backslash as `\\` (C17).
 */
function escapeTag(tag: string): string {
  return tag.replaceAll(/[\\,;]/g, (ch) => `\\${ch}`);
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
  // A reduce, not `Math.max(...)`: spreading ~150k+ arguments overflows the stack (C16).
  const categoryColumns = tagLists.reduce((max, t) => Math.max(max, t.length), 1);
  const headers = [
    'Card ID',
    ...(noteType ? fieldHeaders(noteType) : []),
    ...Array.from({ length: categoryColumns }, (_, i) => `Category ${i + 1}`),
  ];

  const lines = [headers.map((h) => escapeCell(h, delimiter)).join(delimiter)];
  const recordIds = uniqueRecordIds(notes);
  notes.forEach((note, idx) => {
    const tags = tagLists[idx] ?? [];
    const cells = [
      recordIds[idx] ?? note.id,
      ...fields.map((f) => {
        const value = note.fields[f.key] ?? '';
        return options.stripRichText ? stripRichTextMarkup(value) : value;
      }),
      ...Array.from({ length: categoryColumns }, (_, i) => escapeTag(tags[i] ?? '')),
    ];
    lines.push(cells.map((c) => escapeCell(c, delimiter)).join(delimiter));
  });

  const body = lines.join('\r\n') + '\r\n';
  return {
    text: (options.bom === false ? '' : '\uFEFF') + body,
    headers,
    noteCount: notes.length,
  };
}
