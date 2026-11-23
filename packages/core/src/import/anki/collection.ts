import { decodeUtf8 } from '../../utf8-decode.ts';
import { decodeProtobuf, protoNumber, protoString, ProtobufError } from './protobuf.ts';
import {
  ANKI_IMPORT_LIMITS,
  ANKI_REEXPORT_HINT,
  AnkiImportError,
  type AnkiCard,
  type AnkiCollection,
  type AnkiDeckInfo,
  type AnkiImportLimits,
  type AnkiModel,
  type AnkiModelField,
  type AnkiModelTemplate,
  type AnkiNote,
  type AnkiRawPackage,
  type AnkiRevlogEntry,
  type AnkiSqlTable,
  type AnkiSqlValue,
} from './types.ts';

/**
 * Turns the raw SQLite rows of an Anki collection into typed records. Handles both schema 11
 * (models / decks as JSON in `col`) and schema 18 (anki21b: `notetypes`, `fields`, `templates`,
 * `decks` tables with protobuf configs). All input is untrusted: unexpected shapes are skipped,
 * never trusted.
 */

type Row = ReadonlyMap<string, AnkiSqlValue>;

function rowsOf(table: AnkiSqlTable | undefined): Row[] {
  if (!table) return [];
  return table.rows.map((row) => {
    const map = new Map<string, AnkiSqlValue>();
    table.columns.forEach((col, i) => map.set(col.toLowerCase(), row[i] ?? null));
    return map;
  });
}

function str(row: Row, col: string): string {
  const v = row.get(col);
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v instanceof Uint8Array) return decodeUtf8(v);
  return '';
}

function num(row: Row, col: string): number {
  const v = row.get(col);
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function bytes(row: Row, col: string): Uint8Array {
  const v = row.get(col);
  return v instanceof Uint8Array ? v : new Uint8Array(0);
}

/** Integer id as a decimal string (ids are compared as strings everywhere in the importer). */
function idOf(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return '';
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new AnkiImportError('invalid_collection', 'The Anki collection in this file is damaged.');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function byOrd<T extends { ord: number }>(a: T, b: T): number {
  return a.ord - b.ord;
}

/** Schema 11: `col.models` JSON. */
function legacyModel(raw: unknown): AnkiModel | undefined {
  const m = asRecord(raw);
  if (!m) return undefined;
  const id = idOf(m['id']);
  if (!id) return undefined;
  const fields: AnkiModelField[] = asArray(m['flds']).flatMap((f, i) => {
    const r = asRecord(f);
    const name = asString(r?.['name']);
    return name ? [{ name, ord: asInt(r?.['ord'], i) }] : [];
  });
  const templates: AnkiModelTemplate[] = asArray(m['tmpls']).flatMap((t, i) => {
    const r = asRecord(t);
    if (!r) return [];
    return [
      {
        name: asString(r['name']) || `Card ${i + 1}`,
        ord: asInt(r['ord'], i),
        qfmt: asString(r['qfmt']),
        afmt: asString(r['afmt']),
      },
    ];
  });
  return {
    id,
    name: asString(m['name']) || 'Anki note type',
    kind: m['type'] === 1 ? 'cloze' : 'standard',
    fields: fields.toSorted(byOrd),
    templates: templates.toSorted(byOrd),
  };
}

function protoConfig(blob: Uint8Array, what: string): ReturnType<typeof decodeProtobuf> {
  try {
    return decodeProtobuf(blob);
  } catch (err) {
    if (!(err instanceof ProtobufError)) throw err;
    throw new AnkiImportError(
      'unsupported_format',
      `The ${what} settings in this Anki package use a format this app cannot read. ${ANKI_REEXPORT_HINT}`,
    );
  }
}

/** Schema 18: `notetypes` + `fields` + `templates` tables (configs are protobuf). */
function modelsFromTables(raw: AnkiRawPackage): AnkiModel[] {
  const fieldsByType = new Map<string, AnkiModelField[]>();
  for (const row of rowsOf(raw.tables.fields)) {
    const list = fieldsByType.get(str(row, 'ntid')) ?? [];
    list.push({ name: str(row, 'name'), ord: num(row, 'ord') });
    fieldsByType.set(str(row, 'ntid'), list);
  }
  const templatesByType = new Map<string, AnkiModelTemplate[]>();
  for (const row of rowsOf(raw.tables.templates)) {
    const config = protoConfig(bytes(row, 'config'), 'card template');
    const list = templatesByType.get(str(row, 'ntid')) ?? [];
    list.push({
      name: str(row, 'name'),
      ord: num(row, 'ord'),
      qfmt: protoString(config, 1),
      afmt: protoString(config, 2),
    });
    templatesByType.set(str(row, 'ntid'), list);
  }
  return rowsOf(raw.tables.notetypes).map((row) => {
    const id = str(row, 'id');
    const config = protoConfig(bytes(row, 'config'), 'note type');
    return {
      id,
      name: str(row, 'name') || 'Anki note type',
      kind: protoNumber(config, 1) === 1 ? 'cloze' : 'standard',
      fields: (fieldsByType.get(id) ?? []).sort(byOrd),
      templates: (templatesByType.get(id) ?? []).sort(byOrd),
    };
  });
}

function decksFromTables(raw: AnkiRawPackage): AnkiDeckInfo[] {
  return rowsOf(raw.tables.decks).map((row) => {
    // Schema 18 stores the hierarchy with \x1f separators; the `kind` blob's field 2 = filtered.
    const kind = bytes(row, 'kind');
    const filtered = kind.length > 0 && protoConfig(kind, 'deck').has(2);
    return {
      id: str(row, 'id'),
      name: str(row, 'name').replaceAll('\u001f', '::'),
      filtered,
    };
  });
}

function legacyDecks(colDecks: Record<string, unknown>): AnkiDeckInfo[] {
  return Object.values(colDecks).flatMap((raw) => {
    const d = asRecord(raw);
    const id = idOf(d?.['id']);
    if (!d || !id) return [];
    return [{ id, name: asString(d['name']) || 'Default', filtered: d['dyn'] === 1 }];
  });
}

function schedulerVersion(raw: AnkiRawPackage, conf: Record<string, unknown>): number {
  const fromConf = conf['schedVer'];
  if (typeof fromConf === 'number') return fromConf;
  for (const row of rowsOf(raw.tables.config)) {
    if (str(row, 'key') === 'schedVer') {
      const value = Number(str(row, 'val'));
      if (Number.isFinite(value)) return value;
    }
  }
  // Schema 18 collections always run the v3 scheduler; legacy files without it ran v1.
  return raw.format === 'anki21b' ? 3 : 1;
}

function notesOf(raw: AnkiRawPackage): AnkiNote[] {
  return rowsOf(raw.tables.notes).map((row) => ({
    id: str(row, 'id'),
    guid: str(row, 'guid'),
    modelId: str(row, 'mid'),
    tags: str(row, 'tags')
      .split(' ')
      .filter((t) => t.length > 0),
    fields: str(row, 'flds').split('\u001f'),
  }));
}

/** `cards.queue` of a suspended card (buried cards use -2 / -3 and import as normal cards). */
const ANKI_QUEUE_SUSPENDED = -1;

function cardsOf(raw: AnkiRawPackage): AnkiCard[] {
  return rowsOf(raw.tables.cards).map((row) => ({
    id: str(row, 'id'),
    noteId: str(row, 'nid'),
    deckId: str(row, 'did'),
    originalDeckId: str(row, 'odid') || '0',
    ord: num(row, 'ord'),
    suspended: num(row, 'queue') === ANKI_QUEUE_SUSPENDED,
  }));
}

function revlogOf(raw: AnkiRawPackage): AnkiRevlogEntry[] {
  return rowsOf(raw.tables.revlog).map((row) => ({
    id: num(row, 'id'),
    cardId: str(row, 'cid'),
    ease: num(row, 'ease'),
    ivl: num(row, 'ivl'),
    time: num(row, 'time'),
    type: num(row, 'type'),
  }));
}

function assertRowLimits(raw: AnkiRawPackage, limits: AnkiImportLimits): void {
  const checks: Array<[number, number, string]> = [
    [raw.tables.notes?.rows.length ?? 0, limits.maxNotes, 'notes'],
    [raw.tables.cards?.rows.length ?? 0, limits.maxCards, 'cards'],
    [raw.tables.revlog?.rows.length ?? 0, limits.maxRevlog, 'review log entries'],
  ];
  for (const [count, max, what] of checks) {
    if (count > max) {
      throw new AnkiImportError(
        'too_large',
        `This Anki package has ${count} ${what}; the limit for one import is ${max}. Export a smaller deck from Anki.`,
      );
    }
  }
}

/** Normalizes raw collection rows (any supported schema) into an {@link AnkiCollection}. */
export function normalizeAnkiPackage(
  raw: AnkiRawPackage,
  limits: AnkiImportLimits = ANKI_IMPORT_LIMITS,
): AnkiCollection {
  assertRowLimits(raw, limits);
  const colRow = rowsOf(raw.tables.col)[0];
  if (!colRow || !raw.tables.notes) {
    throw new AnkiImportError('invalid_collection', 'The Anki collection in this file is damaged.');
  }
  const colModels = parseJsonObject(str(colRow, 'models'));
  const colDecks = parseJsonObject(str(colRow, 'decks'));
  const conf = parseJsonObject(str(colRow, 'conf'));

  const models = raw.tables.notetypes
    ? modelsFromTables(raw)
    : Object.values(colModels).flatMap((m) => legacyModel(m) ?? []);
  const deckList = raw.tables.decks ? decksFromTables(raw) : legacyDecks(colDecks);
  const decks = new Map(deckList.map((d) => [d.id, d]));

  return {
    format: raw.format,
    schedVer: schedulerVersion(raw, conf),
    models,
    decks,
    notes: notesOf(raw),
    cards: cardsOf(raw),
    revlog: revlogOf(raw),
  };
}
