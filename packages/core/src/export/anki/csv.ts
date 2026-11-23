import type { CollectionState } from '../../events/replay.ts';
import { encodeUtf8 } from '../../ids.ts';
import { escapeCsvCell, selectDeckNotes } from './select.ts';
import { AnkiZipWriter, type AnkiZipEmit } from './zip-writer.ts';
import {
  AnkiMediaNamer,
  ankiFieldHtml,
  ankiFieldNames,
  ankiGuid,
  ankiTags,
  type AnkiMediaFile,
  type AnkiRichTextConverter,
} from './field-html.ts';
import { ankiRichTextToHtml } from './rich-text-html.ts';

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
  /** Converter for rich-text markup in text fields (default: {@link ankiRichTextToHtml}). */
  richText?: AnkiRichTextConverter;
}

export interface AnkiCsvExportPlan {
  /** CSV text (no BOM: Anki's header lines must start the file). */
  text: string;
  /** Base name for files (`<deck slug>`). */
  slug: string;
  noteCount: number;
  /** Media the notes use; read by {@link writeAnkiCsvZip}. */
  media: AnkiMediaFile[];
  /** Notes referenced media the collection does not list (exported without it). */
  unknownMediaCount: number;
}

export interface AnkiCsvExportZip {
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
  const notes = selectDeckNotes(state, options);
  const fields = noteType?.fields ?? [];
  const media = new AnkiMediaNamer(state);
  const ctx = { media, richText: options.richText ?? ankiRichTextToHtml };

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

/** Reads one media file's bytes by hash (`undefined` when this device doesn't have it). */
export type AnkiMediaReader = (hash: string) => Promise<Uint8Array | undefined>;

export interface AnkiCsvZipOptions {
  /** File modification time in the zip (defaults to 1980-01-01). */
  modifiedMs?: number;
}

/**
 * Streams the zip: the CSV, a README for Anki, then each media file as it is read. Media is
 * read one file at a time and handed to `emit` straight away, so the caller never holds all of
 * it (or a finished archive) in memory.
 */
export async function writeAnkiCsvZip(
  plan: AnkiCsvExportPlan,
  readMedia: AnkiMediaReader,
  emit: AnkiZipEmit,
  options: AnkiCsvZipOptions = {},
): Promise<AnkiCsvExportZip> {
  const zip = new AnkiZipWriter(emit, options.modifiedMs);
  zip.add(`${plan.slug}.csv`, encodeUtf8(plan.text), true);
  zip.add('README.txt', encodeUtf8(README.replace(/\n/g, '\r\n')), true);
  let mediaCount = 0;
  let missing = 0;
  for (const file of plan.media) {
    // Backpressure: read the next file only once the sink has taken the previous one.
    await zip.flush();
    const bytes = await readMedia(file.hash);
    if (!bytes) {
      missing += 1;
      continue;
    }
    // Images and audio are already compressed: store them.
    zip.add(`collection.media/${file.name}`, bytes);
    mediaCount += 1;
  }
  zip.finish();
  await zip.flush();
  return {
    fileName: `${plan.slug}-anki.zip`,
    mediaCount,
    missingMediaCount: missing + plan.unknownMediaCount,
  };
}
