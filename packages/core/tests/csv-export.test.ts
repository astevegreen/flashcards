import { describe, expect, it } from 'vitest';
import { createEventFactory, replayAllEvents, type CollectionState } from '../src/events/replay.ts';
import type { KnownEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { buildEventsFromCsv, exportCsv, parseDelimitedText } from '../src/import/csv.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';

const T0 = Date.UTC(2026, 3, 1, 9, 0, 0);
const DECK = 'deck-fd-ko';
const maybeKo = BUILTIN_NOTE_TYPES.find((nt) => nt.id === 'preset:vocab-ko');
if (!maybeKo) throw new Error('Missing preset:vocab-ko');
const koNoteType = maybeKo;

const NFD = (s: string) => s.normalize('NFD');

/**
 * Flashcards Deluxe-style Korean deck: `Text 1..3` + `Category 1..3`. Categories include NFD
 * Hangul (macOS), a `::` hierarchy, a duplicate spelling and a `;`-joined cell.
 */
const FD_CSV =
  'Text 1\tText 2\tText 3\tCategory 1\tCategory 2\tCategory 3\n' +
  `학교\t學校\tschool\ttopik-1\t${NFD('한국어')}\t문법::명사\n` +
  `도서관\t圖書館\tlibrary\ttopik-1\t한국어\t\n` +
  `약속\t約束\t"promise, appointment"\t${NFD('문법::명사')}\tdaily; topik-1\tTOPIK-1\n` +
  '경험\t經驗\texperience\t\t\t\n';

function deckEvents(factory: ReturnType<typeof createEventFactory>): KnownEvent[] {
  return [
    factory.create(
      'DeckCreated',
      { deck_id: DECK, name: 'FD Korean', note_type_id: 'preset:vocab-ko', language: 'ko' },
      T0,
    ),
  ];
}

function importCsv(text: string): CollectionState {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
  const base = deckEvents(factory);
  const res = buildEventsFromCsv(text, {
    deckId: DECK,
    noteType: koNoteType,
    eventFactory: factory,
    nowMs: T0 + 1000,
  });
  expect(res.warnings).toEqual([]);
  return replayAllEvents([...base, ...res.events]);
}

function notesOf(state: CollectionState) {
  return [...state.notes.values()]
    .filter((n) => n.deck_id === DECK)
    .sort((a, b) => a.created_order - b.created_order)
    .map((n) => ({
      id: n.id,
      source_key: n.source_key,
      fields: n.fields,
      tags: n.tags,
      created_order: n.created_order,
      archived: n.archived,
    }));
}

describe('CSV export (Phase 9 categories round trip)', () => {
  it('imports Category 1..N as NFC, deduped tags', () => {
    const notes = notesOf(importCsv(FD_CSV));
    expect(notes.map((n) => n.tags)).toEqual([
      ['topik-1', '한국어', '문법::명사'],
      ['topik-1', '한국어'],
      ['문법::명사', 'daily', 'topik-1'],
      [],
    ]);
    for (const n of notes) for (const t of n.tags) expect(t).toBe(t.normalize('NFC'));
  });

  it('Flashcards Deluxe CSV -> import -> export -> import is lossless (golden)', async () => {
    const first = importCsv(FD_CSV);
    const exported = exportCsv(first, { deckId: DECK });
    expect(exported.noteCount).toBe(4);
    expect(exported.headers).toEqual([
      'Card ID',
      'Word',
      'Hanja / Reading',
      'Meaning',
      'Example',
      'Notes',
      'Image',
      'Audio',
      'Category 1',
      'Category 2',
      'Category 3',
    ]);
    expect(exported.text.startsWith('\uFEFF')).toBe(true);

    // Card IDs are the random source keys minted by the first import; pin them for the golden.
    const keys = notesOf(first).map((n) => n.source_key);
    let golden = exported.text;
    keys.forEach((k, i) => {
      golden = golden.replace(k, `card-${i + 1}`);
    });
    // RFC 4180 CRLF rows; the golden file is stored with LF (repo uses eol=lf).
    expect(golden.split('\r\n')).toHaveLength(6);
    await expect(golden.replace(/\r\n/g, '\n')).toMatchFileSnapshot(
      './__golden__/export-fd-ko.csv.snap',
    );

    const second = importCsv(exported.text);
    expect(notesOf(second)).toEqual(notesOf(first));

    // And once more: export of the re-import is byte-identical.
    expect(exportCsv(second, { deckId: DECK }).text).toBe(exported.text);
    // TSV works the same way.
    const tsv = exportCsv(first, { deckId: DECK, delimiter: '\t', bom: false });
    expect(parseDelimitedText(tsv.text).delimiter).toBe('\t');
    expect(notesOf(importCsv(tsv.text))).toEqual(notesOf(first));
  });

  it('exports only the requested notes and skips archived ones', () => {
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
    const res = buildEventsFromCsv(FD_CSV, {
      deckId: DECK,
      noteType: koNoteType,
      eventFactory: factory,
      nowMs: T0 + 1000,
    });
    const base = [...deckEvents(factory), ...res.events];
    const state = replayAllEvents(base);
    const [a, b] = notesOf(state);
    if (!a || !b) throw new Error('expected imported notes');
    expect(exportCsv(state, { deckId: DECK, noteIds: [a.id, b.id] }).noteCount).toBe(2);

    const archived = replayAllEvents([
      ...base,
      factory.create('NoteArchived', { note_id: a.id }, T0 + 9000),
    ]);
    expect(exportCsv(archived, { deckId: DECK }).noteCount).toBe(3);
    expect(exportCsv(archived, { deckId: DECK, includeArchived: true }).noteCount).toBe(4);
    expect(exportCsv(archived, { deckId: 'missing' }).noteCount).toBe(0);
  });

  it('round-trips the sample Korean, Japanese, Chinese and English decks', () => {
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', SAMPLE_SEED_EPOCH_MS));
    const state = replayAllEvents(buildSampleDeckEvents(factory));
    for (const deck of state.decks.values()) {
      const nt = state.noteTypes.get(deck.note_type_id);
      if (!nt) throw new Error(`missing note type ${deck.note_type_id}`);
      const text = exportCsv(state, { deckId: deck.id }).text;
      const f2 = createEventFactory('dev-c', 0, createHlcState('dev-c', T0));
      const res = buildEventsFromCsv(text, {
        deckId: deck.id,
        noteType: nt,
        eventFactory: f2,
        nowMs: T0,
      });
      expect(res.warnings).toEqual([]);
      const reimported = replayAllEvents([
        f2.create(
          'DeckCreated',
          { deck_id: deck.id, name: deck.name, note_type_id: nt.id, language: deck.language },
          T0,
        ),
        ...res.events,
      ]);
      const pick = (s: CollectionState) =>
        [...s.notes.values()]
          .filter((n) => n.deck_id === deck.id && !n.archived)
          .sort((x, y) => x.created_order - y.created_order || (x.id < y.id ? -1 : 1))
          .map((n) => ({
            id: n.id,
            tags: n.tags,
            fields: Object.fromEntries(Object.entries(n.fields).filter(([, v]) => v !== '')),
          }));
      const expected = pick(state).map((n) => ({
        ...n,
        // Only Note Type fields travel through CSV.
        fields: Object.fromEntries(
          Object.entries(n.fields).filter(
            ([k, v]) => v.trim() !== '' && nt.fields.some((f) => f.key === k),
          ),
        ),
      }));
      expect(pick(reimported)).toEqual(expected);
    }
  });
});

describe('.flashpkg export keeps categories', () => {
  it('round-trips NFC tags and :: hierarchy through .flashpkg', () => {
    const first = importCsv(FD_CSV);
    const bytes = exportFlashpkg(first, { deckId: DECK, name: 'FD Korean' });
    const factory = createEventFactory('dev-z', 0, createHlcState('dev-z', T0 + 10_000));
    const res = importFlashpkg(bytes, replayAllEvents([]), factory, { nowMs: T0 + 10_000 });
    const state = replayAllEvents(res.events);
    const tags = [...state.notes.values()]
      .sort((a, b) => a.created_order - b.created_order)
      .map((n) => n.tags);
    expect(tags).toEqual(notesOf(first).map((n) => n.tags));
  });

  it('normalizes NFD tags on .flashpkg import', () => {
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
    const state = replayAllEvents([
      ...deckEvents(factory),
      factory.create(
        'NoteUpserted',
        {
          note_id: 'n1',
          deck_id: DECK,
          source_key: 'k1',
          fields: { word: '학교', meaning: 'school' },
          tags: [NFD('한국어'), '한국어', NFD('문법::조사')],
        },
        T0 + 1,
      ),
    ]);
    const bytes = exportFlashpkg(state, { deckId: DECK });
    const f2 = createEventFactory('dev-y', 0, createHlcState('dev-y', T0 + 20_000));
    const res = importFlashpkg(bytes, replayAllEvents([]), f2, { nowMs: T0 + 20_000 });
    const note = [...replayAllEvents(res.events).notes.values()][0];
    expect(note?.tags).toEqual(['한국어', '문법::조사']);
  });
});

describe('exports never write one record id twice (C19)', () => {
  // Two notes of one deck can share a source key (one moved in from a deck linked to the same
  // sheet); a third note's own id can equal that key too.
  function sharedKeyState(): CollectionState {
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
    const note = (id: string, sourceKey: string, word: string, order: number) =>
      factory.create(
        'NoteUpserted',
        {
          note_id: id,
          deck_id: DECK,
          source_key: sourceKey,
          fields: { word, meaning: word },
          tags: [],
          provenance: { source: 'import', reviewed: true },
          created_order: order,
        },
        T0 + order + 1,
      );
    return replayAllEvents([
      ...deckEvents(factory),
      note('n1', 'k', 'one', 0),
      note('n2', 'k', 'two', 1),
      note('k', '', 'three', 2),
    ]);
  }

  it('.flashpkg keeps every note', () => {
    const bytes = exportFlashpkg(sharedKeyState(), { deckId: DECK });
    const f2 = createEventFactory('dev-y', 0, createHlcState('dev-y', T0 + 20_000));
    const res = importFlashpkg(bytes, replayAllEvents([]), f2, { nowMs: T0 + 20_000 });
    const words = [...replayAllEvents(res.events).notes.values()].map((n) => n.fields['word']);
    expect(words.sort()).toEqual(['one', 'three', 'two']);
  });

  it('CSV keeps every note without a duplicate Card ID warning', () => {
    const exported = exportCsv(sharedKeyState(), { deckId: DECK });
    expect(notesOf(importCsv(exported.text)).map((n) => n.fields['word'])).toEqual([
      'one',
      'two',
      'three',
    ]);
  });
});

describe('CSV round trip keeps whitespace and separator characters (C17)', () => {
  it('export -> import keeps padded fields and tags that contain , ; or a backslash', () => {
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
    const fields = { word: '  학교', meaning: 'school \n', example: ' a, b ' };
    // Tags like these arrive from .flashpkg or Anki, where `,` and `;` are ordinary characters.
    const tags = ['a,b', 'c;d', 'back\\slash', 'tail\\', 'esc\\,aped', 'plain'];
    const first = replayAllEvents([
      ...deckEvents(factory),
      factory.create(
        'NoteUpserted',
        {
          note_id: 'n1',
          deck_id: DECK,
          source_key: 'card-1',
          fields,
          tags,
          provenance: { source: 'import', reviewed: true },
          created_order: 0,
        },
        T0 + 1,
      ),
    ]);
    for (const delimiter of [',', '\t'] as const) {
      const exported = exportCsv(first, { deckId: DECK, delimiter });
      const [note] = notesOf(importCsv(exported.text));
      expect(note?.fields).toEqual(fields);
      expect(note?.tags).toEqual(tags);
    }
  });

  it('still trims unquoted cells and splits ; or , in a typed category cell', () => {
    const [note] = notesOf(importCsv('Word,Meaning,Tags\n 학교 ,"  school  ", daily; topik-1 \n'));
    expect(note?.fields).toEqual({ word: '학교', meaning: '  school  ' });
    expect(note?.tags).toEqual(['daily', 'topik-1']);
  });
});
