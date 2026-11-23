import { zipSync, type Zippable } from 'fflate';
import type { CollectionState } from '../../events/replay.ts';
import { encodeUtf8 } from '../../ids.ts';
import { escapeCsvCell, selectCsvExportNotes } from '../../import/csv-export.ts';
import {
  AnkiMediaNamer,
  ankiFieldHtml,
  ankiFieldNames,
  ankiGuid,
  ankiTags,
  type AnkiMediaFile,
  type AnkiRichTextConverter,
} from './field-html.ts';

/**
 * "Export for Anki": one deck as a CSV that Anki's text import (File > Import, Anki 2.1.54+)
 * reads with its file headers, zipped with the media files the notes use.
 *
 * Header lines (Anki manual, "Importing > Text files > File headers"):
 * `#separator`, `#html:true`, `#columns`, then `#guid column`, `#notetype column`,
 * `#deck column` and `#tags column` (1-based). Columns: GUID, note type, deck, one per field
 * (HTML, ruby as Anki furigana, media as `<img>` / `[sound:]`), tags (space-separated).
 *
 * Anki's text import does not copy media, so the zip holds the files in `collection.media/` and
 * a short `README.txt` that says to copy them into Anki's own `collection.media` folder.
 *
 * Plain `exportCsv` stays the default: other apps would read these header lines as data.
 */

export interface AnkiCsvExportOptions {
  deckId: string;
  noteIds?: Iterable<string>;
  includeArchived?: boolean;
  delimiter?: ',' | '\t';
  /** Converter for rich-text markup in text fields (none yet; see `AnkiRichTextConverter`). */
  richText?: AnkiRichTextConverter;
}

export interface AnkiCsvExportPlan {
  /** CSV text (no BOM: Anki's header lines must start the file). */
  text: string;
  /** Base name for files (`<deck slug>`). */
  slug: string;
  noteCount: number;
  /** Media the notes use; fetch these hashes and pass them to {@link zipAnkiCsvExport}. */
  media: AnkiMediaFile[];
  /** Notes referenced media the collection does not list (exported without it). */
  unknownMediaCount: number;
}

export interface AnkiCsvExportZip {
  zip: Uint8Array;
  fileName: string;
  mediaCount: number;
  /** Media the notes use but whose bytes were not available on this device. */
  missingMediaCount: number;
}

/** File-name slug for a deck name (ASCII; `deck` when nothing is left). */
export function ankiExportSlug(name: string, fallback = 'deck'): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || fallback
  );
}

/** A `#columns` name: the separator and line breaks would end it early, so they become spaces. */
function columnName(name: string, delimiter: string): string {
  return name
    .replaceAll(delimiter, ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** Builds the Anki CSV for one deck and lists the media it needs. */
export function planAnkiCsvExport(
  state: CollectionState,
  options: AnkiCsvExportOptions,
): AnkiCsvExportPlan {
  const delimiter = options.delimiter ?? ',';
  const deck = state.decks.get(options.deckId);
  const noteType = deck ? state.noteTypes.get(deck.note_type_id) : undefined;
  const notes = selectCsvExportNotes(state, options);
  const fields = noteType?.fields ?? [];
  const media = new AnkiMediaNamer(state);
  const ctx = { media, ...(options.richText ? { richText: options.richText } : {}) };

  const fieldNames = noteType ? ankiFieldNames(noteType) : [];
  const columns = ['GUID', 'Note type', 'Deck', ...fieldNames, 'Tags'];
  const tagsColumn = columns.length;
  const lines = [
    `#separator:${delimiter === '\t' ? 'Tab' : 'Comma'}`,
    '#html:true',
    `#columns:${columns.map((c) => columnName(c, delimiter)).join(delimiter)}`,
    '#guid column:1',
    '#notetype column:2',
    '#deck column:3',
    `#tags column:${tagsColumn}`,
  ];
  for (const note of notes) {
    const cells = [
      ankiGuid(note),
      noteType?.name ?? '',
      deck?.name ?? '',
      ...fields.map((f) => ankiFieldHtml(note.fields[f.key], f, ctx)),
      ankiTags(note.tags).join(' '),
    ];
    lines.push(cells.map((c) => escapeCsvCell(c, delimiter)).join(delimiter));
  }

  return {
    text: lines.join('\r\n') + '\r\n',
    slug: ankiExportSlug(deck?.name ?? 'deck'),
    noteCount: notes.length,
    media: [...media.used.values()],
    unknownMediaCount: media.unknown.size,
  };
}

const README = `Export for Anki

1. In Anki, choose File > Import and pick the .csv file in this folder.
   The file tells Anki the deck, note type, tags and note IDs to use.
   Anki imports into a note type with the name in the "Note type" column. If you don't have one,
   create it first (Tools > Manage Note Types) with the fields named in the import window,
   or use "Export for Anki (.apkg)" instead, which brings its own note types.
2. If there is a collection.media folder here, copy the files inside it into Anki's own
   collection.media folder (in Anki: Tools > Check Media > View Files shows where it is).
`;

/** Zips the CSV, the media files whose bytes are known, and a README for Anki. */
export function zipAnkiCsvExport(
  plan: AnkiCsvExportPlan,
  mediaBytes: ReadonlyMap<string, Uint8Array>,
): AnkiCsvExportZip {
  const csvName = `${plan.slug}.csv`;
  const files: Zippable = {
    [csvName]: encodeUtf8(plan.text),
    'README.txt': encodeUtf8(README.replace(/\n/g, '\r\n')),
  };
  let mediaCount = 0;
  let missing = 0;
  for (const file of plan.media) {
    const bytes = mediaBytes.get(file.hash);
    if (!bytes) {
      missing += 1;
      continue;
    }
    // Images and audio are already compressed: store them.
    files[`collection.media/${file.name}`] = [bytes, { level: 0 }];
    mediaCount += 1;
  }
  return {
    zip: zipSync(files, { level: 6 }),
    fileName: `${plan.slug}-anki.zip`,
    mediaCount,
    missingMediaCount: missing + plan.unknownMediaCount,
  };
}
