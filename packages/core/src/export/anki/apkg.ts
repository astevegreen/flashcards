import { deckNoteType } from '../../model/deck-note-type.ts';
import {
  getEnabledLayoutsForDeck,
  isCardSuspended,
  type CollectionState,
} from '../../events/replay.ts';
import { encodeUtf8 } from '../../ids.ts';
import { noteField } from '../../model/note-fields.ts';
import type { Card, Deck, Layout, Note, NoteType, NoteTypeField } from '../../model/types.ts';
import { sha256String } from '../../sources/hash.ts';
import { sha1First32 } from './checksum.ts';
import { ankiExportSlug, type AnkiMediaReader } from './csv.ts';
import { AnkiZipWriter, type AnkiZipEmit } from './zip-writer.ts';
import {
  AnkiMediaNamer,
  ankiFieldHtml,
  ankiFieldNames,
  ankiGuid,
  ankiTags,
  hasRuby,
  type AnkiMediaFile,
  type AnkiRichTextConverter,
} from './field-html.ts';
import { ankiRichTextToHtml } from './rich-text-html.ts';
import {
  activeReviews,
  ankiCardHistory,
  ankiSchedulingClock,
  revlogRows,
  type AnkiCardScheduling,
  type AnkiRevlogDraft,
} from './scheduling.ts';
import { compareCodeUnits } from '../../compare.ts';

/**
 * `.apkg` export (notes, media, tags, and by default review history and scheduling). Core plans the SQLite rows; the platform
 * writes them into a real SQLite file (`AnkiPackageReader.writeCollection`), and {@link writeApkg} zips
 * that file with the media.
 *
 * Format: the legacy package that every Anki client imports. `collection.anki2` is an Anki
 * schema-11 SQLite collection (note types and decks as JSON in `col`), and `media` is the JSON
 * map `{"0": "file.png"}` with each file stored as zip entry `0`, `1`, … Anki 2.1.50+ also
 * reads newer `collection.anki21b` packages (schema 18, zstd, protobuf), but schema 11 is the
 * one that Anki desktop (2.0 to current), AnkiDroid and AnkiMobile all import, and the one
 * other tools write (genanki). Current Anki upgrades it on import.
 *
 * Mapping:
 * - one Anki deck per deck (`::` in a name is an Anki subdeck; parents are added);
 * - one Anki note type per note type, one Anki field per field (named after its label);
 * - one card template per layout enabled in an exported deck. A note type with a cloze layout
 *   becomes an Anki cloze note type with that layout's template only;
 * - ruby fields use `{{furigana:F}}` (`{{kanji:F}}` on a front that hides furigana, `kana:` /
 *   `kanji:` for layouts that show only readings / bases), typed layouts `{{type:F}}`, and a
 *   layout's text-to-speech field `{{tts xx_YY:F}}`. Choice, listen and draw layouts become
 *   plain flip cards: Anki has no equivalent;
 * - with `includeReviewHistory` (the default), one `revlog` row per active review and each
 *   card's scheduling and FSRS memory state from replay (`./scheduling.ts`); without it, or for
 *   a card with no active review or one marked empty, the card is new. Suspended cards keep
 *   queue -1 either way. The app has no stored bury state, so nothing is exported as buried.
 */

export type AnkiSqlCell = string | number | null;

export interface AnkiExportTable {
  name: string;
  columns: string[];
  rows: AnkiSqlCell[][];
}

/** Everything the platform needs to write `collection.anki2`: DDL, then rows per table. */
export interface AnkiCollectionPlan {
  schema: string[];
  tables: AnkiExportTable[];
}

export interface AnkiApkgExportOptions {
  /** Decks to export (default: every deck that isn't archived). */
  deckIds?: Iterable<string>;
  /** Only these notes (still limited to the decks). */
  noteIds?: Iterable<string>;
  includeArchived?: boolean;
  /** Clock for ids, modification times and due days (core never reads the wall clock). */
  nowMs: number;
  /**
   * The device's UTC offset at export, in minutes east (`-new Date(nowMs).getTimezoneOffset()`).
   * It anchors `crt` and due days; without it the latest review's offset is used, which is a
   * day off near a daylight-saving change.
   */
  tzOffsetMinutes?: number;
  /** Write `revlog` rows and card scheduling from the review events (default true). */
  includeReviewHistory?: boolean;
  /** File name for the package (default from the single deck's name, else `flashcards`). */
  name?: string;
  /** Converter for rich-text markup in text fields (default: `ankiRichTextToHtml`). */
  richText?: AnkiRichTextConverter;
}

export interface AnkiApkgPlan {
  collection: AnkiCollectionPlan;
  media: AnkiMediaFile[];
  fileName: string;
  deckCount: number;
  noteCount: number;
  cardCount: number;
  /** `revlog` rows written (0 without review history). */
  reviewCount: number;
  unknownMediaCount: number;
  /** Notes that came from Anki and keep their Anki GUID (see `ankiGuid`). */
  fromAnkiNoteCount: number;
  /** What could not be carried over, for the user. */
  warnings: string[];
}

export interface AnkiApkgResult {
  fileName: string;
  mediaCount: number;
  missingMediaCount: number;
}

/** Anki's schema 11, exactly as Anki 2.1 creates it (`collection.anki2`). */
export const ANKI_SCHEMA_11: readonly string[] = [
  'CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null)',
  'CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null)',
  'CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null)',
  'CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null)',
  'CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)',
  'CREATE INDEX ix_notes_usn on notes (usn)',
  'CREATE INDEX ix_cards_usn on cards (usn)',
  'CREATE INDEX ix_revlog_usn on revlog (usn)',
  'CREATE INDEX ix_cards_nid on cards (nid)',
  'CREATE INDEX ix_cards_sched on cards (did, queue, due)',
  'CREATE INDEX ix_revlog_cid on revlog (cid)',
  'CREATE INDEX ix_notes_csum on notes (csum)',
];

const FIELD_SEPARATOR = '\u001f';

const CARD_CSS = `.card {
  font-family: arial, sans-serif;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}

.cloze {
  font-weight: bold;
  color: blue;
}

.nightMode .cloze {
  color: lightblue;
}
`;

/** Anki TTS language codes for the languages this app speaks. */
const TTS_LANG: ReadonlyMap<string, string> = new Map([
  ['ja', 'ja_JP'],
  ['ko', 'ko_KR'],
  ['zh-Hans', 'zh_CN'],
  ['zh-Hant', 'zh_TW'],
  ['zh', 'zh_CN'],
  ['en', 'en_US'],
]);

/**
 * The Anki id for a note type. One imported from Anki (`anki:nt:<model id>`) gets its Anki id
 * back, so in the profile it came from Anki sees the same note type and can update its notes
 * (while its fields and card types are unchanged). Others get a stable hashed id.
 */
function ankiModelId(noteType: NoteType): number {
  const m = /^anki:nt:([1-9][0-9]{0,15})$/.exec(noteType.id);
  const id = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(id) ? id : stableId(`anki-export:nt:${noteType.id}`);
}

/** Template order: an imported layout (`anki:layout:<model id>:<ord>`) keeps its Anki ord. */
function layoutOrder(a: Layout, b: Layout): number {
  const ord = (l: Layout) => /^anki:layout:[0-9]+:([0-9]+)$/.exec(l.id)?.[1];
  const oa = ord(a);
  const ob = ord(b);
  if (oa !== undefined && ob !== undefined && oa !== ob) return Number(oa) - Number(ob);
  return compareCodeUnits(a.id, b.id);
}

/** A stable positive id below 2^53 for things Anki matches by id (note types, decks). */
function stableId(key: string): number {
  return 1_000_000_000_000 + Number.parseInt(sha256String(key).slice(0, 11), 16);
}

const NAMED_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

function decodeEntity(entity: string, body: string): string {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const cp = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : entity;
  }
  return NAMED_ENTITIES.get(body) ?? entity;
}

/**
 * Anki's `strip_html_preserving_media_filenames` (rslib `text.rs`), for `sfld` and `csum`: an
 * image becomes ` name `, every other tag (`<br>` too) is deleted, entities are decoded and a
 * no-break space becomes a space. No trimming. Only applied to HTML this export wrote.
 */
export function ankiStripHtmlForSort(html: string): string {
  return html
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, ' $1 ')
    .replace(/<!--[\s\S]*?-->|<[^>]*>/g, '')
    .replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, decodeEntity)
    .replaceAll(' ', ' ');
}

/** Anki's note checksum: the first 8 hex digits of SHA-1 of the stripped first field. */
function fieldChecksum(text: string): number {
  return sha1First32(encodeUtf8(text));
}

const TEXT_KINDS = new Set(['text', 'reading', 'rich']);

interface ModelBuild {
  id: number;
  noteType: NoteType;
  names: string[];
  cloze: boolean;
  layouts: Layout[];
  json: Record<string, unknown>;
}

interface TemplateContext {
  noteType: NoteType;
  names: Map<string, string>;
  rubyFields: ReadonlySet<string>;
}

function fieldRef(
  ctx: TemplateContext,
  key: string,
  layout: Layout,
  front: boolean,
  cloze = false,
): string {
  const name = ctx.names.get(key);
  if (!name) return '';
  const filters: string[] = [];
  if (ctx.rubyFields.has(key)) {
    if (front && layout.hide_furigana_on_front) filters.push('kanji');
    else if (layout.ruby_display === 'readings') filters.push('kana');
    else if (layout.ruby_display === 'bases') filters.push('kanji');
    else filters.push('furigana');
  }
  if (cloze) filters.push('cloze');
  return `{{${[...filters, name].join(':')}}}`;
}

function ttsRef(ctx: TemplateContext, layout: Layout): string {
  if (!layout.speak_field) return '';
  const field = ctx.noteType.fields.find((f) => f.key === layout.speak_field);
  const name = ctx.names.get(layout.speak_field);
  const lang = field ? TTS_LANG.get(field.lang) : undefined;
  if (!field || !name || !lang || !TEXT_KINDS.has(field.kind)) return '';
  return `{{tts ${lang}:${name}}}`;
}

function joinRefs(refs: readonly string[]): string {
  return refs.filter((r) => r.length > 0).join('<br>\n');
}

function backRefs(ctx: TemplateContext, layout: Layout, skip: ReadonlySet<string>): string {
  return layout.reveal_steps
    .map((step) =>
      joinRefs(step.filter((k) => !skip.has(k)).map((k) => fieldRef(ctx, k, layout, false))),
    )
    .filter((s) => s.length > 0)
    .join('<br><br>\n');
}

function standardTemplate(ctx: TemplateContext, layout: Layout, ord: number) {
  const typedKey =
    layout.answer_mode === 'typed'
      ? (layout.answer_field ?? layout.reveal_steps[0]?.[0])
      : undefined;
  const typedName = typedKey ? ctx.names.get(typedKey) : undefined;
  const tts = ttsRef(ctx, layout);
  const speakFront = tts && layout.speak_on !== 'reveal' && layout.speak_on !== 'manual';
  const speakBack = tts && layout.speak_on === 'reveal';
  let qfmt = joinRefs(layout.front_fields.map((k) => fieldRef(ctx, k, layout, true)));
  if (typedName) qfmt += `\n\n{{type:${typedName}}}`;
  if (speakFront) qfmt += `\n${tts}`;
  let afmt =
    '{{FrontSide}}\n\n<hr id=answer>\n\n' + backRefs(ctx, layout, new Set(layout.front_fields));
  if (speakBack) afmt += `\n${tts}`;
  return {
    name: layout.name,
    ord,
    qfmt,
    afmt,
    bqfmt: '',
    bafmt: '',
    did: null,
    bfont: '',
    bsize: 0,
  };
}

function clozeTemplate(ctx: TemplateContext, layout: Layout) {
  const clozeKeys = layout.front_fields.filter((k) => {
    const f = ctx.noteType.fields.find((x) => x.key === k);
    return f !== undefined && TEXT_KINDS.has(f.kind);
  });
  const front = layout.front_fields.map((k) =>
    fieldRef(ctx, k, layout, false, clozeKeys.includes(k)),
  );
  const qfmt = joinRefs(front);
  const afmt = `${qfmt}<br><br>\n${backRefs(ctx, layout, new Set(layout.front_fields))}`;
  return {
    name: layout.name,
    ord: 0,
    qfmt,
    afmt,
    bqfmt: '',
    bafmt: '',
    did: null,
    bfont: '',
    bsize: 0,
  };
}

/** `req` for Anki clients older than 2.1.28: a card is made when any front field is filled. */
function requirements(templates: ReadonlyArray<{ qfmt: string }>, names: readonly string[]) {
  return templates.map((t, ord) => {
    const ords = names.flatMap((name, i) =>
      t.qfmt.includes(`:${name}}}`) || t.qfmt.includes(`{{${name}}}`) ? [i] : [],
    );
    return [ord, 'any', ords.length > 0 ? ords : [0]];
  });
}

function sortFieldIndex(noteType: NoteType): number {
  const i = noteType.fields.findIndex((f) => f.sortKey === true);
  return i === -1 ? 0 : i;
}

function buildModel(
  noteType: NoteType,
  layouts: Layout[],
  rubyFields: ReadonlySet<string>,
  deckId: number,
  nowSecs: number,
  warnings: string[],
): ModelBuild {
  const names = ankiFieldNames(noteType);
  const ctx: TemplateContext = {
    noteType,
    names: new Map(noteType.fields.map((f, i) => [f.key, names[i] ?? f.key])),
    rubyFields,
  };
  const clozeLayout = layouts.find((l) => l.answer_mode === 'cloze');
  let used = layouts;
  if (clozeLayout && layouts.length > 1) {
    warnings.push(
      `"${noteType.name}" has a cloze layout, so it became an Anki cloze note type with only that layout's cards.`,
    );
    used = [clozeLayout];
  }
  const usedNames = new Set<string>();
  const templates = clozeLayout
    ? [clozeTemplate(ctx, clozeLayout)]
    : used.map((l, ord) => {
        const t = standardTemplate(ctx, l, ord);
        let name = t.name.trim() || `Card ${ord + 1}`;
        for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${t.name} ${n}`;
        usedNames.add(name.toLowerCase());
        return { ...t, name };
      });
  const id = ankiModelId(noteType);
  const json: Record<string, unknown> = {
    id,
    name: noteType.name,
    type: clozeLayout ? 1 : 0,
    mod: nowSecs,
    usn: -1,
    sortf: sortFieldIndex(noteType),
    did: deckId,
    tmpls: templates,
    flds: names.map((name, ord) => ({
      name,
      ord,
      sticky: false,
      rtl: false,
      font: 'Arial',
      size: 20,
      media: [],
    })),
    css: CARD_CSS,
    latexPre:
      '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: '\\end{document}',
    latexsvg: false,
    tags: [],
    vers: [],
    ...(clozeLayout ? {} : { req: requirements(templates, names) }),
  };
  return {
    id,
    noteType,
    names,
    cloze: clozeLayout !== undefined,
    layouts: clozeLayout ? [clozeLayout] : used,
    json,
  };
}

function deckJson(id: number, name: string, nowSecs: number): Record<string, unknown> {
  return {
    id,
    name,
    mod: nowSecs,
    usn: -1,
    lrnToday: [0, 0],
    revToday: [0, 0],
    newToday: [0, 0],
    timeToday: [0, 0],
    collapsed: false,
    browserCollapsed: false,
    desc: '',
    dyn: 0,
    conf: 1,
    extendNew: 0,
    extendRev: 0,
  };
}

const DEFAULT_DCONF = {
  id: 1,
  name: 'Default',
  mod: 0,
  usn: 0,
  maxTaken: 60,
  autoplay: true,
  timer: 0,
  replayq: true,
  dyn: false,
  new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
  lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
  rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
};

/** Every exported deck name plus its `::` parents, each once. */
function deckNamesWithParents(decks: readonly Deck[]): string[] {
  const names = new Set<string>();
  for (const deck of decks) {
    const parts = deck.name.split('::');
    for (let i = 1; i < parts.length; i++) names.add(parts.slice(0, i).join('::'));
  }
  return [...names];
}

function chooseDecks(state: CollectionState, options: AnkiApkgExportOptions): Deck[] {
  const wanted = options.deckIds ? new Set(options.deckIds) : null;
  return [...state.decks.values()]
    .filter((d) => (wanted ? wanted.has(d.id) : !d.archived))
    .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id));
}

function chooseNotes(state: CollectionState, deck: Deck, options: AnkiApkgExportOptions): Note[] {
  const wanted = options.noteIds ? new Set(options.noteIds) : null;
  return [...state.notes.values()]
    .filter((n) => n.deck_id === deck.id && (!n.archived || options.includeArchived === true))
    .filter((n) => !wanted || wanted.has(n.id))
    .sort((a, b) => a.created_order - b.created_order || compareCodeUnits(a.id, b.id));
}

/** Layouts of a note type enabled in any of the exported decks (all of them if none is). */
function exportedLayouts(
  state: CollectionState,
  noteType: NoteType,
  decks: readonly Deck[],
): Layout[] {
  const byId = new Map<string, Layout>();
  for (const deck of decks) {
    if (deck.note_type_id !== noteType.id) continue;
    for (const l of getEnabledLayoutsForDeck(state, deck)) byId.set(l.id, l);
  }
  if (byId.size === 0) {
    for (const l of state.layouts.values()) if (l.note_type_id === noteType.id) byId.set(l.id, l);
  }
  return [...byId.values()].sort(layoutOrder);
}

function rubyFieldKeys(noteType: NoteType, notes: readonly Note[]): Set<string> {
  const keys = new Set<string>();
  for (const field of noteType.fields) {
    if (!TEXT_KINDS.has(field.kind)) continue;
    if (notes.some((n) => hasRuby(noteField(n, field.key) ?? ''))) keys.add(field.key);
  }
  return keys;
}

/** Anki card ords for one note: the template of each of its cards (cloze: number − 1). */
function cardOrds(
  state: CollectionState,
  note: Note,
  model: ModelBuild,
): Array<{ ord: number; suspended: boolean; card: Card | undefined }> {
  const out = new Map<number, { suspended: boolean; card: Card; reviews: number }>();
  const cardIds = [...(state.cardIdsByNote.get(note.id) ?? [])].sort(compareCodeUnits);
  for (const cardId of cardIds) {
    const card = state.cards.get(cardId);
    if (!card) continue;
    const index = model.layouts.findIndex((l) => l.id === card.layout_id);
    if (index === -1) continue;
    const ord = model.cloze ? Math.max(0, card.variant - 1) : index;
    const suspended = isCardSuspended(state, card.id);
    const reviews = activeReviews(state, card.id).length;
    const prev = out.get(ord);
    // Two cards on one Anki ord (a cloze note without markers): the history of the one with
    // more reviews is kept; the ord is suspended only when all of them are.
    const keep = prev && prev.reviews >= reviews ? prev : { card, reviews, suspended };
    out.set(ord, { ...keep, suspended: (prev?.suspended ?? true) && suspended });
  }
  if (out.size === 0) return [{ ord: 0, suspended: false, card: undefined }];
  return [...out.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ord, v]) => ({ ord, suspended: v.suspended, card: v.card }));
}

function noteFieldsHtml(
  noteType: NoteType,
  note: Note,
  media: AnkiMediaNamer,
  richText: AnkiRichTextConverter | undefined,
): string[] {
  const ctx = { media, richText: richText ?? ankiRichTextToHtml };
  return noteType.fields.map((f: NoteTypeField) => ankiFieldHtml(noteField(note, f.key), f, ctx));
}

/** Plans an `.apkg` export: SQLite rows for `collection.anki2` and the media it needs. */
export function planAnkiApkgExport(
  state: CollectionState,
  options: AnkiApkgExportOptions,
): AnkiApkgPlan {
  const nowMs = options.nowMs;
  const clock = ankiSchedulingClock(state, nowMs, options.tzOffsetMinutes);
  const crt = clock.crt;
  const withHistory = options.includeReviewHistory !== false;
  const revlog: AnkiRevlogDraft[] = [];
  const nowSecs = Math.floor(nowMs / 1000);
  const warnings: string[] = [];
  const decks = chooseDecks(state, options);
  const media = new AnkiMediaNamer(state);

  const deckRows: Record<string, unknown> = { '1': deckJson(1, 'Default', nowSecs) };
  const deckIdFor = new Map<string, number>();
  for (const deck of decks) {
    const id = stableId(`anki-export:deck:${deck.id}`);
    deckIdFor.set(deck.id, id);
    deckRows[String(id)] = deckJson(id, deck.name, nowSecs);
  }
  const exportedNames = new Set(decks.map((d) => d.name));
  for (const name of deckNamesWithParents(decks)) {
    if (exportedNames.has(name)) continue;
    const id = stableId(`anki-export:deck-name:${name}`);
    deckRows[String(id)] = deckJson(id, name, nowSecs);
  }

  const notesByDeck = new Map(decks.map((d) => [d.id, chooseNotes(state, d, options)]));
  const models = new Map<string, ModelBuild>();
  for (const deck of decks) {
    if (models.has(deck.note_type_id)) continue;
    const noteType = deckNoteType(state, deck);
    if (!noteType) continue;
    const sameType = decks.filter((d) => d.note_type_id === noteType.id);
    const notes = sameType.flatMap((d) => notesByDeck.get(d.id) ?? []);
    const layouts = exportedLayouts(state, noteType, sameType);
    const model = buildModel(
      noteType,
      layouts,
      rubyFieldKeys(noteType, notes),
      deckIdFor.get(deck.id) ?? 1,
      nowSecs,
      warnings,
    );
    models.set(noteType.id, model);
  }

  const noteRows: AnkiSqlCell[][] = [];
  const cardRows: AnkiSqlCell[][] = [];
  let nextNoteId = nowMs;
  let fromAnkiNoteCount = 0;
  let nextCardId = nowMs;
  let position = 0;
  for (const deck of decks) {
    const model = models.get(deck.note_type_id);
    const did = deckIdFor.get(deck.id) ?? 1;
    if (!model) continue;
    for (const note of notesByDeck.get(deck.id) ?? []) {
      const fields = noteFieldsHtml(model.noteType, note, media, options.richText);
      const nid = nextNoteId++;
      if (note.source_key.startsWith('anki:') && note.source_key.length > 5) fromAnkiNoteCount += 1;
      const tags = ankiTags(note.tags);
      const sortText = ankiStripHtmlForSort(fields[sortFieldIndex(model.noteType)] ?? '');
      noteRows.push([
        nid,
        ankiGuid(note),
        model.id,
        nowSecs,
        -1,
        tags.length > 0 ? ` ${tags.join(' ')} ` : '',
        fields.join(FIELD_SEPARATOR),
        sortText,
        fieldChecksum(ankiStripHtmlForSort(fields[0] ?? '')),
        0,
        '',
      ]);
      position += 1;
      for (const { ord, suspended, card } of cardOrds(state, note, model)) {
        const cid = nextCardId++;
        const history =
          withHistory && card && card.empty !== true
            ? ankiCardHistory(state, card, cid, clock)
            : null;
        if (history) revlog.push(...history.revlog);
        const s: AnkiCardScheduling = history?.scheduling ?? {
          type: 0,
          queue: 0,
          due: position,
          ivl: 0,
          factor: 0,
          reps: 0,
          lapses: 0,
          left: 0,
          data: '',
        };
        cardRows.push([
          cid,
          nid,
          did,
          ord,
          nowSecs,
          -1,
          s.type,
          suspended ? -1 : s.queue,
          s.due,
          s.ivl,
          s.factor,
          s.reps,
          s.lapses,
          s.left,
          0,
          0,
          0,
          s.data,
        ]);
      }
    }
  }

  const modelsJson: Record<string, unknown> = {};
  for (const m of models.values()) modelsJson[String(m.id)] = m.json;
  const firstModel = [...models.values()][0];
  const firstDeck = decks[0] ? (deckIdFor.get(decks[0].id) ?? 1) : 1;
  const conf = {
    activeDecks: [firstDeck],
    curDeck: firstDeck,
    newSpread: 0,
    collapseTime: 1200,
    timeLim: 0,
    estTimes: true,
    dueCounts: true,
    curModel: firstModel ? String(firstModel.id) : null,
    nextPos: position + 1,
    sortType: 'noteFld',
    sortBackwards: false,
    addToCur: true,
    // v2 scheduler: revlog eases are 1-4 for learning steps too (v1 had 1-3 there).
    schedVer: 2,
    // Day boundaries for `crt`: rollover hour, and the offset in minutes west of UTC.
    rollover: clock.dayStartHour,
    creationOffset: -clock.tzOffsetMinutes,
  };
  const revlogTable = revlogRows(revlog);

  const collection: AnkiCollectionPlan = {
    schema: [...ANKI_SCHEMA_11],
    tables: [
      {
        name: 'col',
        columns: [
          'id',
          'crt',
          'mod',
          'scm',
          'ver',
          'dty',
          'usn',
          'ls',
          'conf',
          'models',
          'decks',
          'dconf',
          'tags',
        ],
        rows: [
          [
            1,
            crt,
            nowMs,
            nowMs,
            11,
            0,
            0,
            0,
            JSON.stringify(conf),
            JSON.stringify(modelsJson),
            JSON.stringify(deckRows),
            JSON.stringify({ '1': DEFAULT_DCONF }),
            '{}',
          ],
        ],
      },
      {
        name: 'notes',
        columns: [
          'id',
          'guid',
          'mid',
          'mod',
          'usn',
          'tags',
          'flds',
          'sfld',
          'csum',
          'flags',
          'data',
        ],
        rows: noteRows,
      },
      {
        name: 'cards',
        columns: [
          'id',
          'nid',
          'did',
          'ord',
          'mod',
          'usn',
          'type',
          'queue',
          'due',
          'ivl',
          'factor',
          'reps',
          'lapses',
          'left',
          'odue',
          'odid',
          'flags',
          'data',
        ],
        rows: cardRows,
      },
      {
        name: 'revlog',
        columns: ['id', 'cid', 'usn', 'ease', 'ivl', 'lastIvl', 'factor', 'time', 'type'],
        rows: revlogTable,
      },
    ],
  };

  const single = decks.length === 1 ? decks[0] : undefined;
  const baseName = options.name ?? single?.name ?? 'flashcards';
  return {
    collection,
    media: [...media.used.values()],
    fileName: `${ankiExportSlug(baseName, 'flashcards')}.apkg`,
    deckCount: decks.length,
    noteCount: noteRows.length,
    cardCount: cardRows.length,
    reviewCount: revlogTable.length,
    unknownMediaCount: media.unknown.size,
    fromAnkiNoteCount,
    warnings,
  };
}

/**
 * Streams the `.apkg` zip: the written `collection.anki2`, then each media file as it is read
 * (stored as entries `0`, `1`, …), then the JSON `media` map. Media is read one file at a time
 * and handed to `emit` straight away, so the caller never holds it all (or the finished
 * archive) in memory.
 */
export async function writeApkg(
  collectionBytes: Uint8Array,
  plan: Pick<AnkiApkgPlan, 'media' | 'unknownMediaCount' | 'fileName'>,
  readMedia: AnkiMediaReader,
  emit: AnkiZipEmit,
  options: { modifiedMs?: number } = {},
): Promise<AnkiApkgResult> {
  const zip = new AnkiZipWriter(emit, options.modifiedMs);
  zip.add('collection.anki2', collectionBytes, true);
  const map: Record<string, string> = {};
  let index = 0;
  let missing = 0;
  for (const file of plan.media) {
    // Backpressure: read the next file only once the sink has taken the previous one.
    await zip.flush(); // NOSONAR (S9382)
    const bytes = await readMedia(file.hash);
    if (!bytes) {
      missing += 1;
      continue;
    }
    const entry = String(index++);
    map[entry] = file.name;
    zip.add(entry, bytes);
  }
  zip.add('media', encodeUtf8(JSON.stringify(map)), true);
  zip.finish();
  await zip.flush();
  return {
    fileName: plan.fileName,
    mediaCount: index,
    missingMediaCount: missing + plan.unknownMediaCount,
  };
}
