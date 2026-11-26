/**
 * Data shapes for the Anki `.apkg` importer (Phase 12).
 *
 * `AnkiRawPackage` is what the platform reader (unzip + SQLite in a Web Worker) hands to core:
 * plain table rows and media bytes, nothing parsed. `normalizeAnkiPackage` turns it into an
 * `AnkiCollection`, and `convertAnkiCollection` turns that into events.
 */

/** Which collection file the package carried (newest one wins when several are present). */
export type AnkiCollectionFormat = 'anki2' | 'anki21' | 'anki21b';

export type AnkiSqlValue = string | number | Uint8Array | null;

export interface AnkiSqlTable {
  columns: string[];
  rows: AnkiSqlValue[][];
}

/** SQLite tables the reader copies out (those missing from a schema version are omitted). */
export const ANKI_TABLES = [
  'col',
  'config',
  'notes',
  'cards',
  'revlog',
  'notetypes',
  'fields',
  'templates',
  'decks',
] as const;

export type AnkiTableName = (typeof ANKI_TABLES)[number];

export interface AnkiMediaFile {
  /** File name as notes reference it (`<img src>` / `[sound:…]`). */
  name: string;
  bytes: Uint8Array;
}

export interface AnkiRawPackage {
  format: AnkiCollectionFormat;
  tables: Partial<Record<AnkiTableName, AnkiSqlTable>>;
  media: AnkiMediaFile[];
  /** Reader-side notes (e.g. media listed in the map but missing from the zip). */
  warnings: string[];
}

export interface AnkiModelField {
  name: string;
  ord: number;
}

export interface AnkiModelTemplate {
  name: string;
  ord: number;
  qfmt: string;
  afmt: string;
}

export interface AnkiModel {
  id: string;
  name: string;
  kind: 'standard' | 'cloze';
  fields: AnkiModelField[];
  templates: AnkiModelTemplate[];
}

export interface AnkiDeckInfo {
  id: string;
  /** Full name with `::` hierarchy. */
  name: string;
  filtered: boolean;
}

export interface AnkiNote {
  id: string;
  guid: string;
  modelId: string;
  tags: string[];
  /** Raw field HTML in model field order. */
  fields: string[];
}

export interface AnkiCard {
  id: string;
  noteId: string;
  deckId: string;
  /** Home deck while the card sits in a filtered deck (`'0'` otherwise). */
  originalDeckId: string;
  ord: number;
  /** Suspended in Anki (`cards.queue = -1`). Buried cards (`-2`, `-3`) are not suspended. */
  suspended: boolean;
}

export interface AnkiRevlogEntry {
  /** Review time in Unix ms (Anki's revlog id). */
  id: number;
  cardId: string;
  ease: number;
  /** New interval: days when positive, seconds when negative. */
  ivl: number;
  /** Answer time in ms. */
  time: number;
  /** 0 learn, 1 review, 2 relearn, 3 filtered (cram), 4 manual, 5 rescheduled. */
  type: number;
}

export interface AnkiCollection {
  format: AnkiCollectionFormat;
  /** Scheduler version (1 = three learning buttons; 2/3 = four buttons everywhere). */
  schedVer: number;
  models: AnkiModel[];
  decks: Map<string, AnkiDeckInfo>;
  notes: AnkiNote[];
  cards: AnkiCard[];
  revlog: AnkiRevlogEntry[];
}

/** Why an import was refused; `message` is written for the user. */
export type AnkiImportErrorCode =
  'not_apkg' | 'unsupported_format' | 'unsafe_archive' | 'too_large' | 'invalid_collection';

export class AnkiImportError extends Error {
  readonly code: AnkiImportErrorCode;
  constructor(code: AnkiImportErrorCode, message: string) {
    super(message);
    this.name = 'AnkiImportError';
    this.code = code;
  }
}

export { ANKI_IMPORT_LIMITS, type AnkiImportLimits } from './limits.ts';

export const ANKI_REEXPORT_HINT =
  'In Anki, choose File > Export, pick "Anki Deck Package (*.apkg)", tick "Support older Anki versions", and import that file instead.';
