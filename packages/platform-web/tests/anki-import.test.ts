import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyEvents,
  compareCodeUnits,
  compareReviewRecords,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveCardId,
  deriveNoteId,
  isCardSuspended,
  parseRuby,
  sha256Hex,
  type CollectionState,
  type FlashEvent,
  type KnownEvent,
} from '@flash/core';
import {
  ankiDeckId,
  ankiFieldLanguageEvents,
  ankiReviewId,
  AnkiImportError,
  importAnkiPackage,
  MAX_MEDIA_PER_FIELD,
  type AnkiImportOptions,
  type AnkiRawPackage,
} from '@flash/core/anki';
import initSqlJs from 'sql.js';
import { describe, expect, it, vi } from 'vitest';
import {
  handleAnkiReadRequest,
  transferableInput,
  transferablesOf,
  type AnkiReadResponse,
} from '../src/anki/anki-reader-protocol.ts';
import {
  readApkg,
  stripUnicaseCollation,
  type ApkgReadOptions,
  type ApkgReaderDeps,
} from '../src/anki/apkg-reader.ts';
import { WebAnkiPackageReader, type AnkiReaderWorkerLike } from '../src/anki/web-anki-reader.ts';
import { zstdDecompressCapped } from '../src/anki/zstd.ts';

const FIXTURES = resolve(fileURLToPath(import.meta.url), '../../../../tests/fixtures/anki');
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const sqlite = initSqlJs();

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

async function deps(): Promise<ApkgReaderDeps> {
  const SQL = await sqlite;
  return { openDatabase: async (b) => new SQL.Database(b), zstdDecompress: zstdDecompressCapped };
}

async function read(name: string, options?: ApkgReadOptions): Promise<AnkiRawPackage> {
  return readApkg(fixture(name), await deps(), options);
}

function importInto(
  state: CollectionState,
  raw: AnkiRawPackage,
  options: AnkiImportOptions = {},
  device = 'device-a',
) {
  const factory = createEventFactory(device, 0, createHlcState(device, NOW));
  const result = importAnkiPackage(raw, state, factory, { nowMs: NOW, ...options });
  applyEvents(state, result.events);
  return result;
}

async function importFixture(name: string, options: AnkiImportOptions = {}) {
  const state = createEmptyState();
  const raw = await read(name, { includeReviewHistory: options.includeReviewHistory === true });
  const result = importInto(state, raw, options);
  return { state, result, raw };
}

function activeNotes(state: CollectionState) {
  return [...state.notes.values()]
    .filter((n) => !n.archived)
    .sort((a, b) => a.created_order - b.created_order);
}

function eventsOfType<T extends KnownEvent['type']>(events: readonly KnownEvent[], type: T) {
  return events.filter((e): e is Extract<KnownEvent, { type: T }> => e.type === type);
}

/** Rewrites one column of every row of `table` in `raw` (for hand-crafted hostile variants). */
function mapColumn(
  raw: AnkiRawPackage,
  table: 'notes' | 'cards',
  column: string,
  fn: (value: unknown, row: unknown[]) => unknown,
): void {
  const t = raw.tables[table];
  if (!t) throw new Error(`fixture has no ${table} table`);
  const idx = t.columns.indexOf(column);
  t.rows = t.rows.map((row) => {
    const next = [...row];
    next[idx] = fn(row[idx], row) as (typeof row)[number];
    return next;
  });
}

/** Everything a user can see or that drives scheduling (HLC registers excluded). */
function visibleState(state: CollectionState) {
  const byId = <T extends { id: string }>(xs: Iterable<T>) =>
    [...xs].sort((a, b) => compareCodeUnits(a.id, b.id));
  return {
    decks: byId(state.decks.values()).map((d) => ({ ...d, created_at: 0 })),
    noteTypes: byId(state.noteTypes.values()),
    layouts: byId(state.layouts.values()),
    notes: byId(state.notes.values()),
    cards: byId(state.cards.values()),
    media: [...state.media.keys()].sort(compareCodeUnits),
    reviews: [...state.reviewsByCard.values()]
      .flat()
      .map(({ hlc: _hlc, ...rest }) => rest)
      .sort((a, b) => a.reviewed_at - b.reviewed_at || compareCodeUnits(a.review_id, b.review_id)),
  };
}

describe('Anki .apkg import: golden conversions', () => {
  it('Basic (and reversed card): note type, two layouts, hierarchical deck, HTML to text, tags', async () => {
    const { state, result } = await importFixture('basic-reversed.apkg');
    const deckId = ankiDeckId('1600000000100', '1600000000001');
    expect(result.summary).toMatchObject({ decks: 1, newDecks: 1, notes: 2, noteTypes: 1 });
    expect(result.warnings).toEqual([]);
    expect(state.decks.get(deckId)).toMatchObject({
      name: 'Japanese::Vocab',
      note_type_id: 'anki:nt:1600000000001',
    });
    expect(state.noteTypes.get('anki:nt:1600000000001')).toEqual({
      id: 'anki:nt:1600000000001',
      name: 'Basic (and reversed card)',
      fields: [
        { key: 'front', label: 'Front', kind: 'text', lang: 'zh-Hans', sortKey: true },
        { key: 'back', label: 'Back', kind: 'rich', lang: 'en' },
      ],
    });
    expect(state.layouts.get('anki:layout:1600000000001:0')).toEqual({
      id: 'anki:layout:1600000000001:0',
      note_type_id: 'anki:nt:1600000000001',
      name: 'Card 1',
      front_fields: ['front'],
      reveal_steps: [['back']],
      answer_mode: 'flip',
      hide_furigana_on_front: false,
      enabled: true,
    });
    expect(state.layouts.get('anki:layout:1600000000001:1')).toMatchObject({
      name: 'Card 2',
      front_fields: ['back'],
      reveal_steps: [['front']],
      enabled: true,
    });
    expect(activeNotes(state).map((n) => [n.source_key, n.fields, n.tags])).toEqual([
      ['anki:guidDog01', { front: '犬', back: 'dog\n(animal)' }, ['animals::mammals', 'pets']],
      ['anki:guidCat02', { front: '猫', back: 'cat\nfeline' }, ['animals::mammals']],
    ]);
    const dogId = deriveNoteId(deckId, 'anki:guidDog01');
    expect(state.notes.get(dogId)?.provenance).toEqual({ source: 'import', reviewed: true });
    expect(state.cards.has(deriveCardId(dogId, 'anki:layout:1600000000001:0', 0))).toBe(true);
    expect(state.cards.has(deriveCardId(dogId, 'anki:layout:1600000000001:1', 0))).toBe(true);
    expect(state.cards.size).toBe(4);
  });

  it('Cloze: one cloze layout, Anki cloze syntax kept (hints too), one card per cloze number', async () => {
    const { state } = await importFixture('cloze.apkg');
    const deckId = ankiDeckId('1600000000200', '1600000000002');
    expect(state.decks.get(deckId)?.name).toBe('Geography');
    expect(state.layouts.get('anki:layout:1600000000002:0')).toMatchObject({
      answer_mode: 'cloze',
      front_fields: ['text'],
      reveal_steps: [['back_extra']],
    });
    expect(activeNotes(state).map((n) => n.fields)).toEqual([
      { text: '{{c1::東京}}は日本の{{c2::首都::capital}}です', back_extra: 'Tokyo' },
      { text: '{{c1::Seoul}} is in {{c2::Korea}}' },
    ]);
    const tokyo = deriveNoteId(deckId, 'anki:guidTokyo3');
    for (const variant of [1, 2]) {
      expect(state.cards.has(deriveCardId(tokyo, 'anki:layout:1600000000002:0', variant))).toBe(
        true,
      );
    }
    expect(state.cards.size).toBe(4);
  });

  it('Japanese furigana: Anki space rule -> ruby syntax, kanji: filter hides furigana on the front, tts -> speak_field', async () => {
    const { state } = await importFixture('japanese-furigana.apkg');
    const readings = activeNotes(state).map((n) => n.fields['reading']);
    expect(readings).toEqual([
      '私[わたし]は日本語[にほんご]を勉強[べんきょう]します',
      '{食べる|たべる}',
      '日本[にほん]語[ご]',
    ]);
    expect(parseRuby(readings[0] ?? '')).toEqual([
      { type: 'ruby', base: '私', reading: 'わたし' },
      { type: 'text', value: 'は' },
      { type: 'ruby', base: '日本語', reading: 'にほんご' },
      { type: 'text', value: 'を' },
      { type: 'ruby', base: '勉強', reading: 'べんきょう' },
      { type: 'text', value: 'します' },
    ]);
    expect(state.layouts.get('anki:layout:1600000000003:0')).toMatchObject({
      front_fields: ['reading'],
      reveal_steps: [['meaning']],
      hide_furigana_on_front: true,
      speak_field: 'expression',
      speak_on: 'reveal',
    });
    const expression = state.noteTypes
      .get('anki:nt:1600000000003')
      ?.fields.find((f) => f.key === 'expression');
    expect(expression).toMatchObject({ lang: 'ja', tts: true });
    expect([...state.decks.values()][0]?.language).toBe('ja');
  });

  it('media: numbered zip entries -> media:<sha256> fields; SVG and missing files are skipped', async () => {
    const { state, result } = await importFixture('media.apkg');
    const notes = activeNotes(state);
    const png = result.extractedMedia.find((m) => m.ext === 'png');
    const mp3 = result.extractedMedia.find((m) => m.ext === 'mp3');
    expect(png?.mime).toBe('image/png');
    expect(mp3?.mime).toBe('audio/mpeg');
    expect(png && sha256Hex(png.bytes)).toBe(png?.hash);
    expect(notes[0]?.fields).toEqual({
      front: '犬',
      front_image: `media:${png?.hash}`,
      back: 'dog',
      back_audio: `media:${mp3?.hash}`,
    });
    expect(notes[1]?.fields).toEqual({ front: '猫', back: 'cat' });
    expect(result.extractedMedia).toHaveLength(2);
    expect(eventsOfType(result.events, 'MediaAdded').map((e) => e.payload.media.ext)).toEqual(
      expect.arrayContaining(['png', 'mp3']),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'Skipped media of unsupported types: svg.',
        '1 media file(s) referenced by notes are not in the package.',
      ]),
    );
    expect(state.layouts.get('anki:layout:1600000000004:0')).toMatchObject({
      front_fields: ['front', 'front_image'],
      reveal_steps: [['back', 'back_audio']],
    });
  });

  it('media names ending in inherited object keys (constructor, __proto__) are unsupported, not trusted', async () => {
    const state = createEmptyState();
    const raw = await read('media.apkg');
    mapColumn(raw, 'notes', 'flds', (flds) => {
      const [front = '', back = '', ...rest] = String(flds).split('');
      if (!front.includes('猫')) return flds;
      return [`${front}<img src="x.constructor">`, `${back}<img src="y.__proto__">`, ...rest].join(
        '',
      );
    });
    raw.media.push(
      { name: 'x.constructor', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'y.__proto__', bytes: new Uint8Array([4, 5, 6]) },
    );
    const result = importInto(state, raw);
    const added = eventsOfType(result.events, 'MediaAdded').map((e) => e.payload.media);
    expect(added.map((m) => m.ext).sort(compareCodeUnits)).toEqual(['mp3', 'png']);
    expect(added.every((m) => typeof m.mime === 'string')).toBe(true);
    expect(result.extractedMedia.every((m) => typeof m.mime === 'string')).toBe(true);
    expect(activeNotes(state)[1]?.fields).toEqual({ front: '猫', back: 'cat' });
    expect(result.warnings).toContain(
      'Skipped media of unsupported types: __proto__, constructor, svg.',
    );
  });

  it('warns when a template had no card for some notes in Anki (conditional reverse card)', async () => {
    const state = createEmptyState();
    const raw = await read('basic-reversed.apkg');
    const cards = raw.tables.cards;
    if (!cards) throw new Error('fixture has no cards table');
    const nid = cards.columns.indexOf('nid');
    const ord = cards.columns.indexOf('ord');
    const firstNote = cards.rows[0]?.[nid];
    cards.rows = cards.rows.filter((row) => !(row[nid] === firstNote && row[ord] === 1));
    const result = importInto(state, raw);
    expect(result.warnings).toEqual([
      '1 note(s) of "Basic (and reversed card)" had no "Card 2" card in Anki; every imported note gets one here.',
    ]);
  });

  it('anki21b (zstd + protobuf + schema 18) imports with \\x1f deck hierarchy and media', async () => {
    const { state, result, raw } = await importFixture('anki21b.apkg');
    expect(raw.format).toBe('anki21b');
    expect([...state.decks.values()].map((d) => [d.name, d.language])).toEqual([
      ['Korean::Greetings', 'ko'],
    ]);
    expect(activeNotes(state).map((n) => [n.fields, n.tags])).toEqual([
      [
        {
          field_1: '안녕하세요',
          field_1_image: `media:${result.extractedMedia[0]?.hash}`,
          english: 'Hello',
        },
        ['greetings::formal'],
      ],
      [{ field_1: '고마워요', english: 'Thanks (polite)' }, ['greetings']],
    ]);
    expect(state.noteTypes.get('anki:nt:1600000000005')?.fields.map((f) => f.label)).toEqual([
      '한국어',
      '한국어 (image)',
      'English',
    ]);
  });

  it('anki21b: reads the real schema-18 DDL (COLLATE unicase, WITHOUT ROWID) despite sql.js lacking unicase', async () => {
    const base = await deps();
    const schema: string[] = [];
    const raw = await readApkg(fixture('anki21b.apkg'), {
      ...base,
      openDatabase: async (b) => {
        const db = await base.openDatabase(b);
        const rows = db.exec("SELECT sql FROM sqlite_master WHERE name IN ('tags', 'notetypes')");
        schema.push(...(rows[0]?.values ?? []).map((r) => String(r[0])));
        return db;
      },
    });
    expect(schema).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^CREATE TABLE tags \(tag text NOT NULL PRIMARY KEY COLLATE unicase.* without rowid$/,
        ),
        expect.stringContaining('name text NOT NULL COLLATE unicase'),
      ]),
    );
    expect(raw.tables.notetypes?.rows).toHaveLength(1);
    expect(raw.tables.fields?.rows).toHaveLength(2);
  });

  it('stripUnicaseCollation removes only COLLATE unicase clauses', () => {
    expect(stripUnicaseCollation('CREATE TABLE t (a text NOT NULL COLLATE unicase, b int)')).toBe(
      'CREATE TABLE t (a text NOT NULL, b int)',
    );
    expect(
      stripUnicaseCollation('CREATE TABLE t (a PRIMARY KEY collate\n  UNICASE) without rowid'),
    ).toBe('CREATE TABLE t (a PRIMARY KEY) without rowid');
    expect(
      stripUnicaseCollation(
        "CREATE TABLE unicase (x COLLATE nocase, 'unicase', mycollate unicase, y COLLATE unicase2)",
      ),
    ).toBe(
      "CREATE TABLE unicase (x COLLATE nocase, 'unicase', mycollate unicase, y COLLATE unicase2)",
    );
  });

  it('prefers collection.anki21 over the legacy stub collection.anki2', async () => {
    const raw = await read('cloze.apkg');
    expect(raw.format).toBe('anki21');
    const notes = raw.tables.notes?.rows ?? [];
    expect(notes).toHaveLength(2);
  });
});

describe('Anki .apkg import: untrusted HTML', () => {
  it('drops script/style/iframe/svg with their content and every attribute; keeps text only', async () => {
    const { state, result } = await importFixture('html-script.apkg');
    const fields = activeNotes(state)[0]?.fields ?? {};
    expect(fields).toEqual({ front: 'Hello world', back: 'link <b>not bold</b> & done' });
    const allText = JSON.stringify([...state.notes.values()].map((n) => n.fields));
    for (const bad of [
      'alert',
      'script',
      'iframe',
      'onerror',
      'onclick',
      'javascript:',
      'display',
    ]) {
      expect(allText).not.toContain(bad);
    }
    expect(result.warnings).toContain(
      'Removed scripts, styles or embedded frames from 2 field(s).',
    );
  });
});

describe('Anki .apkg import: review history (default OFF)', () => {
  const cardA = '1600000011001';

  it('is off by default: the review log is not even read and no ReviewRecorded is emitted', async () => {
    const raw = await read('review-history.apkg');
    expect(raw.tables.revlog).toBeUndefined();
    const state = createEmptyState();
    const result = importInto(state, raw);
    expect(eventsOfType(result.events, 'ReviewRecorded')).toHaveLength(0);
    expect(result.summary.reviews).toBe(0);
    expect([...state.cards.values()].every((c) => c.schedule.reps === 0)).toBe(true);
  });

  it('maps ease 1-4 to ratings and skips manual, rescheduled, cram, unknown-card and bad entries', async () => {
    const { state, result } = await importFixture('review-history.apkg', {
      includeReviewHistory: true,
      tzOffsetMinutes: 540,
    });
    expect(result.summary.reviews).toBe(6);
    expect(result.summary.skippedReviews).toEqual({
      manual: 2,
      filtered: 1,
      unknownCard: 1,
      invalid: 1,
      duplicate: 0,
    });
    const reviews = eventsOfType(result.events, 'ReviewRecorded').map((e) => e.payload);
    const T0 = 1_700_000_000_000;
    expect(reviews.map((r) => [r.reviewed_at - T0, r.rating, r.duration_ms])).toEqual([
      [0, 3, 8000],
      [600_000, 3, 6000],
      [86_400_000, 3, 5000],
      [2 * 86_400_000, 2, 9000],
      [4 * 86_400_000, 1, 12000],
      [4 * 86_400_000 + 600_000, 3, 7000],
    ]);
    expect(reviews[0]?.review_id).toBe(ankiReviewId(T0, cardA));
    expect(reviews.every((r) => r.tz_offset === 540 && r.fsrs_params_version === 0)).toBe(true);
    // Learning step of 600 s -> due 10 min later; review of 3 days -> due 3 days later.
    expect(reviews[0]?.resulting_due_at).toBe(T0 + 600_000);
    expect(reviews[2]?.resulting_due_at).toBe(T0 + 86_400_000 + 3 * 86_400_000);
    // The card in the filtered deck lands in its home deck (Default) and keeps its review.
    expect(state.decks.size).toBe(1);
    const scheduled = [...state.cards.values()].map((c) => c.schedule.reps).sort((a, b) => a - b);
    expect(scheduled).toEqual([1, 5]);
    const lapsed = [...state.cards.values()].find((c) => c.schedule.reps === 5);
    expect(lapsed?.schedule.lapses).toBe(1);
  });

  it('replays deterministically: shuffled delivery and a second import give the same state', async () => {
    const raw = await read('review-history.apkg', { includeReviewHistory: true });
    const first = createEmptyState();
    const result = importInto(first, raw, { includeReviewHistory: true });

    const shuffled = createEmptyState();
    const events: FlashEvent[] = [...result.events].reverse();
    applyEvents(shuffled, events.slice(0, 7));
    applyEvents(shuffled, events.slice(7));
    expect(visibleState(shuffled)).toEqual(visibleState(first));

    // Same package on another device (different HLCs and event ids) converges too.
    const other = createEmptyState();
    importInto(other, raw, { includeReviewHistory: true }, 'device-b');
    expect(visibleState(other)).toEqual(visibleState(first));

    // Reviews replay in (reviewed_at, hlc, review_id) order regardless of event order.
    for (const list of first.reviewsByCard.values()) {
      const sorted = [...list].sort(compareReviewRecords).map((r) => r.reviewed_at);
      expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
    }
  });

  it('importing the same package twice changes nothing and emits no new events', async () => {
    const raw = await read('review-history.apkg', { includeReviewHistory: true });
    const state = createEmptyState();
    importInto(state, raw, { includeReviewHistory: true });
    const before = visibleState(state);
    const again = importInto(state, raw, { includeReviewHistory: true });
    expect(again.events).toEqual([]);
    expect(again.summary.skippedReviews.duplicate).toBe(6);
    expect(again.summary.newDecks).toBe(0);
    expect(visibleState(state)).toEqual(before);
  });

  it('a re-import after an edit only upserts the changed note and restores archived ones', async () => {
    const raw = await read('basic-reversed.apkg');
    const state = createEmptyState();
    importInto(state, raw);
    const [dog, cat] = activeNotes(state);
    const factory = createEventFactory('device-a', 100, createHlcState('device-a', NOW + 1000));
    applyEvents(state, [
      factory.create(
        'NoteUpserted',
        {
          note_id: dog?.id ?? '',
          deck_id: dog?.deck_id ?? '',
          source_key: dog?.source_key ?? '',
          fields: { front: 'edited', back: 'x' },
        },
        NOW + 1000,
      ),
      factory.create('NoteArchived', { note_id: cat?.id ?? '' }, NOW + 1000),
    ]);
    const again = importInto(state, raw, {}, 'device-a');
    expect(again.events.map((e) => e.type).sort(compareCodeUnits)).toEqual([
      'NoteRestored',
      'NoteUpserted',
    ]);
  });
});

describe('Anki .apkg import: Phase 14 follow-ups', () => {
  it('kana: / kanji: fields keep full ruby; the layout flag decides readings-only or bases-only', async () => {
    const { state, result } = await importFixture('kana.apkg');
    expect(activeNotes(state).map((n) => n.fields)).toEqual([
      {
        expression: '日本語[にほんご]を話[はな]す',
        reading: '私[わたし]は日本語[にほんご]を話[はな]します',
        meaning: 'I speak Japanese',
      },
      { expression: '食[た]べる', reading: '食[た]べる', meaning: 'to eat' },
    ]);
    expect(state.layouts.get('anki:layout:1600000000006:0')).toMatchObject({
      front_fields: ['reading'],
      reveal_steps: [['meaning']],
      hide_furigana_on_front: false,
      ruby_display: 'readings',
    });
    expect(state.layouts.get('anki:layout:1600000000006:1')).toMatchObject({
      front_fields: ['expression'],
      reveal_steps: [['meaning']],
      hide_furigana_on_front: true,
      ruby_display: 'bases',
    });
    const langs = state.noteTypes.get('anki:nt:1600000000006')?.fields.map((f) => f.lang);
    expect(langs).toEqual(['ja', 'ja', 'en']);
    expect(result.warnings).toContain(
      '1 media file(s) referenced by notes are not in the package.',
    );
  });

  it('suspended cards (queue -1) import as CardSuspended; buried cards import as normal', async () => {
    const { state, result } = await importFixture('suspended.apkg');
    const deckId = ankiDeckId('1600000000700', '1600000000001');
    const card = (guid: string, ord: number) =>
      deriveCardId(deriveNoteId(deckId, `anki:${guid}`), `anki:layout:1600000000001:${ord}`, 0);
    expect(result.summary.suspended).toBe(2);
    expect(eventsOfType(result.events, 'CardSuspended').map((e) => e.payload)).toEqual([
      { card_id: card('guidSusp17', 0), reason: 'manual' },
      { card_id: card('guidSusp19', 1), reason: 'manual' },
    ]);
    expect(isCardSuspended(state, card('guidSusp17', 0))).toBe(true);
    expect(isCardSuspended(state, card('guidSusp17', 1))).toBe(false);
    expect(isCardSuspended(state, card('guidSusp18', 0))).toBe(false);
    expect(isCardSuspended(state, card('guidSusp18', 1))).toBe(false);
    expect(isCardSuspended(state, card('guidSusp19', 1))).toBe(true);
    expect(state.cards.size).toBe(6);
  });

  it('a re-import never suspends again a card that was unsuspended here', async () => {
    const raw = await read('suspended.apkg');
    const state = createEmptyState();
    const first = importInto(state, raw);
    const cardId = eventsOfType(first.events, 'CardSuspended')[0]?.payload.card_id ?? '';
    const factory = createEventFactory('device-a', 100, createHlcState('device-a', NOW + 1000));
    applyEvents(state, [factory.create('CardUnsuspended', { card_id: cardId }, NOW + 1000)]);
    const again = importInto(state, raw, {}, 'device-a');
    expect(again.events).toEqual([]);
    expect(again.summary.suspended).toBe(0);
    expect(isCardSuspended(state, cardId)).toBe(false);
  });

  it('keeps every image and sound of a field (duplicates once, missing files skipped)', async () => {
    const raw = await read('multi-media.apkg');
    const state = createEmptyState();
    const result = importInto(state, raw);
    const media = (name: string) => {
      const bytes = raw.media.find((m) => m.name === name)?.bytes ?? new Uint8Array();
      return `media:${sha256Hex(bytes)}`;
    };
    expect(result.extractedMedia).toHaveLength(4);
    const [apple, pear] = activeNotes(state);
    expect(apple?.fields).toEqual({
      front: '사과',
      front_image: media('apple.png'),
      front_image_2: media('apple-2.png'),
      back: 'apple',
      back_audio: media('apple.mp3'),
      back_audio_2: media('apple-slow.mp3'),
    });
    expect(pear?.fields).toEqual({ front: '배', front_image: media('apple-2.png'), back: 'pear' });
    const noteType = state.noteTypes.get('anki:nt:1600000000004');
    expect(noteType?.fields.map((f) => [f.key, f.label, f.kind])).toEqual([
      ['front', 'Front', 'text'],
      ['front_image', 'Front (image)', 'image'],
      ['front_image_2', 'Front (image 2)', 'image'],
      ['back', 'Back', 'text'],
      ['back_audio', 'Back (audio)', 'audio'],
      ['back_audio_2', 'Back (audio 2)', 'audio'],
    ]);
    expect(state.layouts.get('anki:layout:1600000000004:0')).toMatchObject({
      front_fields: ['front', 'front_image', 'front_image_2'],
      reveal_steps: [['back', 'back_audio', 'back_audio_2']],
    });
    expect(result.warnings).toEqual([
      '1 media file(s) referenced by notes are not in the package.',
    ]);
  });

  it('media past the per-field cap is dropped and never stored', async () => {
    const state = createEmptyState();
    const raw = await read('media.apkg');
    const extra = 3;
    const names = Array.from({ length: MAX_MEDIA_PER_FIELD + extra }, (_, i) => `cap-${i}.png`);
    mapColumn(raw, 'notes', 'flds', (flds) => {
      const [front = '', ...rest] = String(flds).split('');
      if (!front.includes('猫')) return flds;
      return [front + names.map((n) => `<img src="${n}">`).join(''), ...rest].join('');
    });
    names.forEach((name, i) => raw.media.push({ name, bytes: new Uint8Array([0xca, 0xfe, i]) }));
    const result = importInto(state, raw);
    const referenced = new Set(
      activeNotes(state).flatMap((n) =>
        Object.values(n.fields).filter((v) => v.startsWith('media:')),
      ),
    );
    const added = eventsOfType(result.events, 'MediaAdded').map(
      (e) => `media:${e.payload.media.hash}`,
    );
    expect(added.every((ref) => referenced.has(ref))).toBe(true);
    expect(result.extractedMedia.every((m) => referenced.has(`media:${m.hash}`))).toBe(true);
    const dropped = names.slice(MAX_MEDIA_PER_FIELD).map((n) => {
      const bytes = raw.media.find((m) => m.name === n)?.bytes ?? new Uint8Array();
      return `media:${sha256Hex(bytes)}`;
    });
    expect(dropped.some((ref) => added.includes(ref))).toBe(false);
    expect(result.summary.media).toBe(result.extractedMedia.length);
    expect(
      result.warnings.some((w) => w.includes(`${extra} image or sound reference(s) were dropped`)),
    ).toBe(true);
  });

  it('reports each field with its detected language, and a change becomes events', async () => {
    const { state, result } = await importFixture('basic-reversed.apkg');
    const deckId = ankiDeckId('1600000000100', '1600000000001');
    expect(result.noteTypes).toEqual([
      {
        noteTypeId: 'anki:nt:1600000000001',
        name: 'Basic (and reversed card)',
        deckIds: [deckId],
        languageFieldKey: 'front',
        fields: [
          { key: 'front', name: 'Front', lang: 'zh-Hans', mediaKeys: [] },
          { key: 'back', name: 'Back', lang: 'en', mediaKeys: [] },
        ],
      },
    ]);
    const imported = result.noteTypes[0];
    if (!imported) throw new Error('no note type');
    const factory = createEventFactory('device-a', 100, createHlcState('device-a', NOW + 1000));
    const events = ankiFieldLanguageEvents(state, imported, 'front', 'ja', factory, NOW + 1000);
    expect(events.map((e) => e.type)).toEqual(['NoteTypeChanged', 'DeckSettingsChanged']);
    applyEvents(state, events);
    expect(state.noteTypes.get(imported.noteTypeId)?.fields[0]?.lang).toBe('ja');
    expect(state.decks.get(deckId)?.language).toBe('ja');
    // Same language again: nothing to do. Another field: only the note type changes.
    expect(ankiFieldLanguageEvents(state, imported, 'front', 'ja', factory)).toEqual([]);
    const back = ankiFieldLanguageEvents(state, imported, 'back', 'ko', factory);
    expect(back.map((e) => e.type)).toEqual(['NoteTypeChanged']);
    // Untrusted input is ignored.
    expect(ankiFieldLanguageEvents(state, imported, 'front', '<b>', factory)).toEqual([]);
    expect(ankiFieldLanguageEvents(state, imported, 'nope', 'ko', factory)).toEqual([]);
    // A re-import keeps the corrected languages (existing note types keep the user's edits).
    applyEvents(state, back);
    importInto(state, await read('basic-reversed.apkg'), {}, 'device-a');
    expect(state.noteTypes.get(imported.noteTypeId)?.fields.map((f) => f.lang)).toEqual([
      'ja',
      'ko',
    ]);
  });

  it('companion media fields follow their text field when its language changes', async () => {
    const { state, result } = await importFixture('multi-media.apkg');
    const imported = result.noteTypes[0];
    if (!imported) throw new Error('no note type');
    const factory = createEventFactory('device-a', 100, createHlcState('device-a', NOW + 1000));
    applyEvents(state, ankiFieldLanguageEvents(state, imported, 'front', 'ja', factory));
    const fields = state.noteTypes.get(imported.noteTypeId)?.fields ?? [];
    const langs = new Map(fields.map((f) => [f.key, f.lang]));
    expect([langs.get('front'), langs.get('front_image'), langs.get('front_image_2')]).toEqual([
      'ja',
      'ja',
      'ja',
    ]);
    expect(langs.get('back')).toBe('en');
  });
});

describe('Anki .apkg import: archive safeguards', () => {
  async function rejection(name: string, options?: ApkgReadOptions): Promise<AnkiImportError> {
    const err = await read(name, options).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnkiImportError);
    return err as AnkiImportError;
  }

  it.each([
    ['malicious-traversal.apkg', 'Path traversal'],
    ['malicious-traversal-nested.apkg', 'Path traversal'],
    ['malicious-absolute.apkg', 'Absolute path'],
    ['malicious-drive-letter.apkg', 'Absolute path'],
    ['malicious-backslash.apkg', 'Backslash'],
  ])('rejects %s', async (name, why) => {
    const err = await rejection(name);
    expect(err.code).toBe('unsafe_archive');
    expect(err.message).toContain(why);
  });

  it('enforces the file-count cap', async () => {
    const err = await rejection('malicious-too-many-files.apkg', { limits: { maxFiles: 50 } });
    expect(err.code).toBe('unsafe_archive');
    expect(err.message).toContain('maximum file count (50)');
  });

  it('counts inflated bytes while streaming, ignoring the lying size header (zip bomb)', async () => {
    const err = await rejection('malicious-zip-bomb.apkg', {
      limits: { maxSingleFileBytes: 1024 * 1024 },
    });
    expect(err.code).toBe('unsafe_archive');
    expect(err.message).toContain('Inflated file "0" exceeds max single-file size');
  });

  it('enforces the total uncompressed cap', async () => {
    const err = await rejection('malicious-zip-bomb.apkg', {
      limits: { maxTotalUncompressedBytes: 2 * 1024 * 1024 },
    });
    expect(err.message).toContain('max uncompressed byte limit');
  });

  it('rejects a zstd bomb from its frame headers without decompressing it', async () => {
    const base = await deps();
    const zstdDecompress = vi.fn(base.zstdDecompress);
    const err = await readApkg(fixture('malicious-zstd-bomb.apkg'), {
      ...base,
      zstdDecompress,
    }).then(
      () => undefined,
      (e: unknown) => e as AnkiImportError,
    );
    expect(err?.code).toBe('too_large');
    expect(zstdDecompress).not.toHaveBeenCalled();
  });

  it('caps zstd output while streaming even when headers look small', () => {
    const big = new Uint8Array(300_000);
    const encoded = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58];
    const bh = (300_000 << 3) | (1 << 1) | 1; // one RLE block of 300 000 bytes
    encoded.push(bh & 0xff, (bh >> 8) & 0xff, (bh >> 16) & 0xff, 0);
    expect(() => zstdDecompressCapped(new Uint8Array(encoded), 100_000)).toThrow(AnkiImportError);
    expect(zstdDecompressCapped(new Uint8Array(encoded), 400_000)).toEqual(big);
  });

  it('explains non-Anki files and newer formats in user-facing words', async () => {
    const notAnki = await rejection('not-anki.apkg');
    expect(notAnki.code).toBe('not_apkg');
    const newer = await rejection('newer-format.apkg');
    expect(newer.code).toBe('unsupported_format');
    expect(newer.message).toContain('Support older Anki versions');
  });

  it('rejects a damaged SQLite collection', async () => {
    const { buildZip } = await import('../../../scripts/build-anki-fixtures.mjs');
    const err = await readApkg(
      buildZip([{ name: 'collection.anki2', data: new TextEncoder().encode('not sqlite') }]),
      await deps(),
    ).then(
      () => undefined,
      (e: unknown) => e as AnkiImportError,
    );
    expect(err?.code).toBe('invalid_collection');
  });
});

describe('Anki import worker plumbing', () => {
  it('protocol keeps AnkiImportError codes and always settles', async () => {
    const posted: AnkiReadResponse[] = [];
    await handleAnkiReadRequest(
      { type: 'read', bytes: new Uint8Array([1]), includeReviewHistory: false },
      () => Promise.reject(new AnkiImportError('not_apkg', 'nope')),
      (m) => posted.push(m),
    );
    expect(posted).toEqual([
      { type: 'stage', stage: 'reading' },
      { type: 'error', message: 'nope', code: 'not_apkg' },
    ]);
    const malformed: AnkiReadResponse[] = [];
    await handleAnkiReadRequest(
      { type: 'nope' },
      () => Promise.reject(new Error('x')),
      (m) => malformed.push(m),
    );
    expect(malformed).toEqual([{ type: 'error', message: 'Malformed Anki import request' }]);
  });

  it('transfers media buffers out of the worker and a whole input buffer into it', () => {
    const shared = new Uint8Array(8);
    const own = new Uint8Array([9]);
    const pkg: AnkiRawPackage = {
      format: 'anki21',
      tables: {},
      warnings: [],
      media: [
        { name: 'a.png', bytes: shared.subarray(0, 4) },
        { name: 'b.png', bytes: shared.subarray(4) },
        { name: 'c.mp3', bytes: own },
      ],
    };
    expect(transferablesOf({ type: 'done', pkg })).toEqual([shared.buffer, own.buffer]);
    expect(transferablesOf({ type: 'stage', stage: 'reading' })).toEqual([]);
    expect(transferableInput(own)).toEqual([own.buffer]);
    expect(transferableInput(shared.subarray(1))).toEqual([]);
  });

  it('WebAnkiPackageReader forwards options, rebuilds errors and terminates the worker', async () => {
    const terminate = vi.fn();
    const sent: unknown[] = [];
    const worker: AnkiReaderWorkerLike = {
      onmessage: null,
      onerror: null,
      terminate,
      postMessage(message) {
        sent.push(message);
        queueMicrotask(() =>
          worker.onmessage?.({
            data: { type: 'error', message: 'too big', code: 'too_large' },
          } as MessageEvent<AnkiReadResponse>),
        );
      },
    };
    const reader = new WebAnkiPackageReader(() => worker);
    const err = await reader.read(new Uint8Array([1, 2]), { includeReviewHistory: true }).then(
      () => undefined,
      (e: unknown) => e as AnkiImportError,
    );
    expect(err).toBeInstanceOf(AnkiImportError);
    expect(err?.code).toBe('too_large');
    expect(sent).toEqual([
      { type: 'read', bytes: new Uint8Array([1, 2]), includeReviewHistory: true },
    ]);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
