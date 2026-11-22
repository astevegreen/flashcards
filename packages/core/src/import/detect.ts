import { decodeUtf8 } from '../ids.ts';
import { parseDelimitedText } from './csv.ts';
import { listZipEntryNames } from './zip-entries.ts';

/**
 * Phase 14 "Bring my cards": works out what someone dropped, picked or pasted, so the guided
 * import can hand it to the right existing importer (Anki `.apkg`, `.flashpkg`, CSV/TSV incl.
 * Flashcards Deluxe, or a linked Google Sheet). Pure and cheap: it sniffs magic bytes, lists zip
 * entry names without inflating anything, reads only the first part of a text file for its
 * header row, and parses URLs by hand. The file name is never trusted; it only shapes messages.
 */

export type AnkiCollectionKind = 'anki2' | 'anki21' | 'anki21b';

export type UnsupportedImportReason =
  | 'empty'
  | 'zip-other'
  | 'xlsx'
  | 'sqlite'
  | 'binary'
  | 'utf16'
  | 'no-columns'
  | 'anki-text'
  | 'google-docs'
  | 'google-published'
  | 'google-drive-file'
  | 'url-other'
  | 'not-recognized';

export type DetectedImport =
  | { kind: 'anki'; collection: AnkiCollectionKind }
  | { kind: 'flashpkg' }
  | {
      kind: 'csv';
      /** `flashcards-deluxe` when the header uses its `Text 1`, `Text 2`, … columns. */
      dialect: 'flashcards-deluxe' | 'generic';
      delimiter: ',' | '\t';
      headers: string[];
    }
  | { kind: 'google-sheets'; spreadsheetId: string; url: string }
  | { kind: 'unsupported'; reason: UnsupportedImportReason; message: string };

/** How much of a text file is read to find its header row. */
const TEXT_SNIFF_BYTES = 64 * 1024;

const SUPPORTED_HINT =
  'Bring my cards reads Anki packages (.apkg), .flashpkg files, CSV/TSV files (including Flashcards Deluxe exports) and Google Sheets links.';

function unsupported(reason: UnsupportedImportReason, message: string): DetectedImport {
  return { kind: 'unsupported', reason, message };
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

const SQLITE_MAGIC = [...'SQLite format 3'].map((c) => c.charCodeAt(0));

function lowerExtension(fileName: string | undefined): string {
  if (!fileName) return '';
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/** Says when a file is named like a format it does not contain (the name is only a hint). */
function misnamedPrefix(fileName: string | undefined): string {
  const ext = lowerExtension(fileName);
  if (ext === 'apkg' || ext === 'colpkg')
    return `"${fileName}" is named like an Anki package, but it isn't one. `;
  if (ext === 'flashpkg') return `"${fileName}" is named like a .flashpkg file, but it isn't one. `;
  if (ext === 'csv' || ext === 'tsv')
    return `"${fileName}" is named like a CSV file, but it isn't one. `;
  return '';
}

function newestAnkiCollection(names: ReadonlySet<string>): AnkiCollectionKind | undefined {
  if (names.has('collection.anki21b')) return 'anki21b';
  if (names.has('collection.anki21')) return 'anki21';
  if (names.has('collection.anki2')) return 'anki2';
  return undefined;
}

function detectZip(entries: readonly string[], fileName: string | undefined): DetectedImport {
  const names = new Set(entries);
  const anki = newestAnkiCollection(names);
  if (anki) return { kind: 'anki', collection: anki };
  if (names.has('manifest.json')) return { kind: 'flashpkg' };
  if (names.has('[Content_Types].xml') && entries.some((n) => n.startsWith('xl/'))) {
    return unsupported(
      'xlsx',
      'This is an Excel workbook. Save it as CSV (or upload it to Google Sheets and paste the link), then try again.',
    );
  }
  return unsupported(
    'zip-other',
    `${misnamedPrefix(fileName)}This zip file holds neither an Anki collection nor a .flashpkg manifest. ${SUPPORTED_HINT}`,
  );
}

/** Index where a UTF-8 sequence starting with lead byte `b0` would end, or -1 if invalid. */
function utf8SequenceLength(b0: number): number {
  if (b0 < 0x80) return 1;
  if (b0 >= 0xc2 && b0 <= 0xdf) return 2;
  if (b0 >= 0xe0 && b0 <= 0xef) return 3;
  if (b0 >= 0xf0 && b0 <= 0xf4) return 4;
  return -1;
}

/**
 * True when `bytes` reads as UTF-8 text with no NUL bytes. A sequence cut off by the end of the
 * sample is fine (the sample is a prefix of the file).
 */
function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    if (b0 === 0) return false;
    const length = utf8SequenceLength(b0);
    if (length === -1) return false;
    for (let k = 1; k < length && i + k < bytes.length; k++) {
      if (((bytes[i + k] ?? 0) & 0xc0) !== 0x80) return false;
    }
    i += length;
  }
  return true;
}

/** `Text 1`, `text2`, `TEXT  3` (Flashcards Deluxe positional columns). */
function isFlashcardsDeluxeTextHeader(header: string): boolean {
  const norm = header.trim().toLowerCase();
  if (!norm.startsWith('text')) return false;
  const digits = norm.slice(4).trim();
  if (digits.length === 0) return false;
  for (const ch of digits) {
    if (ch < '0' || ch > '9') return false;
  }
  return true;
}

/** Text with a header row of two or more columns is a CSV/TSV table. */
function detectDelimitedText(text: string): DetectedImport {
  // Anki 2.1.55+ "Notes in Plain Text" exports start with `#separator:` / `#html:` headers.
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  if (body.startsWith('#separator:')) {
    return unsupported(
      'anki-text',
      'This is an Anki plain-text export. In Anki, choose File > Export and pick "Anki Deck Package (*.apkg)" instead, so note types, media and furigana come along.',
    );
  }
  const parsed = parseDelimitedText(text);
  const headers = parsed.headers.filter((h) => h.length > 0);
  if (headers.some(isFlashcardsDeluxeTextHeader)) {
    return { kind: 'csv', dialect: 'flashcards-deluxe', delimiter: parsed.delimiter, headers };
  }
  if (parsed.headers.length >= 2 && headers.length > 0) {
    return { kind: 'csv', dialect: 'generic', delimiter: parsed.delimiter, headers };
  }
  return unsupported(
    'no-columns',
    `This text has no columns. A CSV/TSV file needs a header row, such as "Text 1, Text 2" from Flashcards Deluxe or your note type's field names. ${SUPPORTED_HINT}`,
  );
}

function detectBinary(bytes: Uint8Array, fileName: string | undefined): DetectedImport {
  if (startsWithBytes(bytes, SQLITE_MAGIC)) {
    return unsupported(
      'sqlite',
      `${misnamedPrefix(fileName)}This is a raw Anki collection database. In Anki, choose File > Export and pick "Anki Deck Package (*.apkg)", then bring that file.`,
    );
  }
  return unsupported(
    'not-recognized',
    `${misnamedPrefix(fileName)}This file isn't a format this app can import. ${SUPPORTED_HINT}`,
  );
}

/**
 * Detects the format of a picked or dropped file from its bytes. `fileName` is only used to word
 * messages; a file named `.apkg` that holds a CSV table is a CSV file.
 */
export function detectImportFile(bytes: Uint8Array, fileName?: string): DetectedImport {
  if (bytes.length === 0) return unsupported('empty', 'This file is empty.');
  const zipEntries = listZipEntryNames(bytes);
  if (zipEntries) return detectZip(zipEntries, fileName);
  if (startsWithBytes(bytes, [0xff, 0xfe]) || startsWithBytes(bytes, [0xfe, 0xff])) {
    return unsupported(
      'utf16',
      'This text file is saved as UTF-16. Save it again as "CSV UTF-8" (or tab-delimited UTF-8 text) and try again.',
    );
  }
  const sample = bytes.subarray(0, TEXT_SNIFF_BYTES);
  if (!looksLikeUtf8Text(sample)) return detectBinary(bytes, fileName);
  // Only the header row matters here, so a row cut off by the sample size is harmless.
  const text = decodeUtf8(sample);
  if (text.trim().length === 0) return unsupported('empty', 'This file is empty.');
  return detectDelimitedText(text);
}

// ---------------------------------------------------------------------------------------------
// Pasted text: a Google Sheets link (or rows of CSV/TSV)
// ---------------------------------------------------------------------------------------------

function isIdChar(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '-' ||
    ch === '_'
  );
}

function isDriveFileId(id: string): boolean {
  if (id.length < 10 || id.length > 200) return false;
  for (const ch of id) {
    if (!isIdChar(ch)) return false;
  }
  return true;
}

interface ParsedLink {
  host: string;
  segments: string[];
}

/** Splits `https://host/a/b?x#y` without `URL` (core has no DOM or Node globals). */
function parseLink(text: string): ParsedLink | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  let rest: string;
  if (lower.startsWith('https://')) rest = trimmed.slice(8);
  else if (lower.startsWith('http://')) rest = trimmed.slice(7);
  else return undefined;
  if (rest.length === 0 || [...rest].some((ch) => ch === ' ' || ch === '\n' || ch === '\t')) {
    return undefined;
  }
  let end = rest.length;
  for (const stop of ['?', '#']) {
    const at = rest.indexOf(stop);
    if (at !== -1 && at < end) end = at;
  }
  const [host = '', ...segments] = rest.slice(0, end).split('/');
  return { host: host.toLowerCase(), segments: segments.filter((s) => s.length > 0) };
}

/** The id after `d/` in `spreadsheets/[u/<n>/]d/<id>/…`; `e` marks a published-to-web link. */
function spreadsheetIdFrom(segments: readonly string[]): string | undefined {
  const dIndex = segments.indexOf('d');
  if (segments[0] !== 'spreadsheets' || dIndex === -1) return undefined;
  return segments[dIndex + 1];
}

/**
 * Reads a Google Sheets link (`https://docs.google.com/spreadsheets/d/<id>/edit#gid=0`, with or
 * without the `/u/<n>` account part) into the spreadsheet id and a canonical edit URL.
 */
export function parseGoogleSheetsUrl(
  text: string,
): { spreadsheetId: string; url: string } | undefined {
  const link = parseLink(text);
  if (!link || link.host !== 'docs.google.com') return undefined;
  const id = spreadsheetIdFrom(link.segments);
  if (!id || !isDriveFileId(id)) return undefined;
  return { spreadsheetId: id, url: `https://docs.google.com/spreadsheets/d/${id}/edit` };
}

function detectGoogleDocsLink(segments: readonly string[]): DetectedImport | undefined {
  const [first, second, third] = segments;
  if (first === 'spreadsheets' && second === 'd' && third === 'e') {
    return unsupported(
      'google-published',
      'This is a "Publish to the web" link. Open the Sheet in Google Sheets and paste the link from the address bar (it contains /spreadsheets/d/…).',
    );
  }
  if (first === 'spreadsheets') {
    return unsupported(
      'url-other',
      "This Google Sheets link doesn't point to one spreadsheet. Open the Sheet and paste the link from the address bar.",
    );
  }
  if (first === 'document') {
    return unsupported(
      'google-docs',
      'This is a Google Doc. Docs become lesson pages: link them under Sources with "Select Google Sheets or Docs".',
    );
  }
  return undefined;
}

function detectGoogleLink(link: ParsedLink): DetectedImport {
  if (link.host === 'docs.google.com') {
    const docs = detectGoogleDocsLink(link.segments);
    if (docs) return docs;
  }
  if (link.host === 'drive.google.com') {
    return unsupported(
      'google-drive-file',
      'This is a Google Drive file link. Open the file in Google Sheets and paste that link, or download the file and choose it here.',
    );
  }
  return unsupported(
    'url-other',
    `This link isn't a Google Sheets link. ${SUPPORTED_HINT} To import a file from elsewhere, download it first and choose it here.`,
  );
}

/**
 * Detects pasted text: a Google Sheets link, or rows of CSV/TSV with a header row. Any other link
 * or text is unsupported, with a message saying what would work.
 */
export function detectImportText(text: string): DetectedImport {
  if (text.trim().length === 0) return unsupported('empty', 'Paste a Google Sheets link first.');
  const sheets = parseGoogleSheetsUrl(text);
  if (sheets) return { kind: 'google-sheets', ...sheets };
  const link = parseLink(text);
  if (link) return detectGoogleLink(link);
  return detectDelimitedText(text.slice(0, TEXT_SNIFF_BYTES));
}
