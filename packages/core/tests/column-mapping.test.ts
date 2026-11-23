import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyEvents, createEmptyState, createEventFactory } from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import {
  applyColumnTargets,
  decodeColumnTarget,
  encodeColumnTarget,
  guessColumnMapping,
  guessDeckSetup,
  hasMappingProblems,
  looksLikeHeaderRow,
  mappingProblems,
  previewMappedRows,
  resolveSourceColumnMap,
  toSourceColumnMap,
  type ColumnTarget,
} from '../src/import/column-mapping.ts';
import { buildEventsFromCsv } from '../src/import/csv.ts';
import { BUILTIN_NOTE_TYPE_IDS, BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';
import type { NoteType } from '../src/model/types.ts';
import { diffTabularSource } from '../src/sources/tabular.ts';

function preset(id: string): NoteType {
  const found = BUILTIN_NOTE_TYPES.find((nt) => nt.id === id);
  if (!found) throw new Error(`missing preset ${id}`);
  return found;
}

const KO = preset(BUILTIN_NOTE_TYPE_IDS.VOCAB_KO);
const JA = preset(BUILTIN_NOTE_TYPE_IDS.VOCAB_JA);
const NO_NOTES: NoteType = {
  id: 'custom:front-back',
  name: 'Front/Back',
  fields: [
    { key: 'front', label: 'Front', kind: 'text', lang: 'ko', sortKey: true },
    { key: 'back', label: 'Back', kind: 'text', lang: 'en' },
  ],
};

const targetsOf = (grid: string[][], nt: NoteType = KO, hasHeaderRow?: boolean) =>
  guessColumnMapping(grid, nt, hasHeaderRow === undefined ? {} : { hasHeaderRow }).columns.map(
    (c) => encodeColumnTarget(c.target),
  );

/** The owner's usual layout (Google Sheets / .xlsx / .csv). */
const OWNER_GRID = [
  ['word', 'definition', 'example', 'category1', 'category2', 'category3'],
  ['나무', 'tree', '나무가 커요.', 'nature', 'A1', 'noun'],
  ['하늘', 'sky', '하늘이 파래요.', 'nature', 'A1', 'noun'],
  ['먹다', 'to eat', '밥을 먹어요.', 'food', 'A1', 'verb'],
  ['마시다', 'to drink', '물을 마셔요.', 'food', 'A1', 'verb'],
];

describe('guessColumnMapping: header names', () => {
  it("maps the owner's word / definition / example / category1-3 layout", () => {
    const guess = guessColumnMapping(OWNER_GRID, KO);
    expect(guess.hasHeaderRow).toBe(true);
    expect(guess.columns.map((c) => encodeColumnTarget(c.target))).toEqual([
      'field:word',
      'field:meaning',
      'field:example',
      'tags',
      'tags',
      'tags',
    ]);
    expect(guess.columns.every((c) => c.reason === 'header')).toBe(true);
    expect(guess.columns[0]?.samples).toEqual(['나무', '하늘', '먹다']);
  });

  it('keeps exact field labels first (the app’s own CSV export round-trips)', () => {
    const grid = [
      ['Word', 'Hanja / Reading', 'Meaning', 'Example', 'Notes', 'Tags', 'Card ID'],
      ['학교', '學校', 'school', '', 'n', 'place', 'id-1'],
    ];
    expect(targetsOf(grid)).toEqual([
      'field:word',
      'field:hanja',
      'field:meaning',
      'ignore', // empty column
      'field:notes',
      'tags',
      'card_id',
    ]);
  });

  it('reads Korean, numbered, punctuated and differently cased headers', () => {
    const grid = [
      ['단어', '뜻', '예문 1', 'Part-of-Speech', 'Topic_2', 'ID'],
      ['사과', 'apple', '사과를 먹어요.', 'noun', 'food', 'k1'],
    ];
    expect(targetsOf(grid)).toEqual([
      'field:word',
      'field:meaning',
      'field:example',
      'tags',
      'tags',
      'card_id',
    ]);
  });

  it('gives each field one column: a second "meaning" column goes to Notes', () => {
    const grid = [
      ['word', 'meaning', 'translation'],
      ['물', 'water', 'water (drink)'],
    ];
    expect(targetsOf(grid)).toEqual(['field:word', 'field:meaning', 'notes']);
  });

  it('maps Flashcards Deluxe Text N by position and Category N to tags', () => {
    const grid = [
      ['Text 1', 'Text 2', 'Text 3', 'Category 1'],
      ['개', 'dog', '狗', 'animals'],
    ];
    expect(targetsOf(grid)).toEqual(['field:word', 'field:hanja', 'field:meaning', 'tags']);
  });

  it('sends unknown columns with content to Notes, and empty ones nowhere', () => {
    const grid = [
      ['word', 'meaning', 'source', 'blank'],
      ['책', 'book', 'textbook p.3', ''],
    ];
    const guess = guessColumnMapping(grid, KO);
    expect(guess.columns.map((c) => [encodeColumnTarget(c.target), c.reason])).toEqual([
      ['field:word', 'header'],
      ['field:meaning', 'header'],
      ['notes', 'unknown'],
      ['ignore', 'empty'],
    ]);
  });

  it('does not offer Notes on a note type without a Notes field', () => {
    const grid = [
      ['front', 'back', 'mystery'],
      ['산', 'mountain', 'x'],
    ];
    expect(targetsOf(grid, NO_NOTES)).toEqual(['field:front', 'field:back', 'ignore']);
  });
});

describe('guessColumnMapping: content and position', () => {
  it('reads Korean words, English glosses, sentences and repeated categories from the rows', () => {
    const grid = [
      ['a', 'b', 'c', 'd'],
      ['나무', 'tree', '나무가 정말 커요.', 'nature'],
      ['하늘', 'sky', '하늘이 정말 파래요.', 'nature'],
      ['먹다', 'to eat', '밥을 빨리 먹어요.', 'food'],
      ['마시다', 'to drink', '물을 많이 마셔요.', 'food'],
    ];
    const guess = guessColumnMapping(grid, KO, { hasHeaderRow: true });
    expect(guess.columns.map((c) => [encodeColumnTarget(c.target), c.reason])).toEqual([
      ['field:word', 'content'],
      ['field:meaning', 'content'],
      ['field:example', 'content'],
      ['tags', 'content'],
    ]);
  });

  it('falls back to column order for the front and the meaning', () => {
    const grid = [
      ['x', 'y'],
      ['alpha', 'first letter'],
      ['beta', 'second letter'],
    ];
    expect(targetsOf(grid, KO, true)).toEqual(['field:word', 'field:meaning']);
    const guess = guessColumnMapping(grid, KO, { hasHeaderRow: true });
    expect(guess.columns.map((c) => c.reason)).toEqual(['position', 'position']);
  });

  it('spots image and audio columns by their values', () => {
    const hash = 'a'.repeat(64);
    const grid = [
      ['word', 'pic', 'clip'],
      ['고양이', `media:${hash}`, 'https://example.com/a.mp3'],
      ['개', '=IMAGE("https://example.com/dog.png")', 'https://example.com/b.ogg'],
    ];
    expect(targetsOf(grid)).toEqual(['field:word', 'field:image', 'field:audio']);
  });
});

describe('looksLikeHeaderRow', () => {
  it('is true for known names and for unknown English names over English rows', () => {
    expect(looksLikeHeaderRow(OWNER_GRID)).toBe(true);
    expect(
      looksLikeHeaderRow([
        ['alpha', 'beta'],
        ['one', 'two'],
      ]),
    ).toBe(true);
  });

  it('is false when row 1 looks like the Korean data below it', () => {
    const grid = [
      ['나무', 'tree', 'nature'],
      ['하늘', 'sky', 'nature'],
      ['바다', 'sea', 'nature'],
    ];
    expect(looksLikeHeaderRow(grid)).toBe(false);
    const guess = guessColumnMapping(grid, KO);
    expect(guess.hasHeaderRow).toBe(false);
    expect(guess.columns.map((c) => c.header)).toEqual(['Column 1', 'Column 2', 'Column 3']);
    expect(guess.columns[0]?.samples).toEqual(['나무', '하늘', '바다']);
  });
});

describe('guessDeckSetup', () => {
  it('picks the note type and language from the script of the rows', () => {
    expect(guessDeckSetup(OWNER_GRID)).toEqual({
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      language: 'ko',
    });
    expect(
      guessDeckSetup([
        ['word', 'meaning'],
        ['食べる', 'to eat'],
      ]),
    ).toEqual({ noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA, language: 'ja' });
    expect(
      guessDeckSetup([
        ['word', 'meaning'],
        ['朋友', 'friend'],
      ]),
    ).toEqual({ noteTypeId: BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH, language: 'zh-Hans' });
    expect(
      guessDeckSetup([
        ['Pinyin', 'Word'],
        ['ni3', '你'],
      ]).noteTypeId,
    ).toBe(BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH);
  });
});

describe('mapping checks and preview', () => {
  it('flags a missing front, a field chosen twice and two Card ID columns', () => {
    const p = mappingProblems(
      [
        { kind: 'field', fieldKey: 'meaning' },
        { kind: 'field', fieldKey: 'meaning' },
        { kind: 'card_id' },
        { kind: 'card_id' },
        { kind: 'notes' },
        { kind: 'field', fieldKey: 'notes' },
        { kind: 'field', fieldKey: 'notes' },
      ],
      KO,
    );
    expect(p).toEqual({
      missingFront: 'word',
      duplicateFields: ['meaning'],
      duplicateCardId: true,
    });
    expect(hasMappingProblems(p)).toBe(true);
    const ok = mappingProblems(
      guessColumnMapping(OWNER_GRID, KO).columns.map((c) => c.target),
      KO,
    );
    expect(hasMappingProblems(ok)).toBe(false);
  });

  it('previews rows as stored: flat tags from every category column in order, Notes lines', () => {
    const grid = [
      ['word', 'definition', 'category1', 'category2', 'source'],
      ['나무', 'tree', 'nature', 'A1; noun', 'book'],
      ['', '', '', '', ''],
      ['하늘', 'sky', 'nature', 'A1', ''],
    ];
    const targets = guessColumnMapping(grid, KO).columns.map((c) => c.target);
    expect(previewMappedRows(grid, targets, KO, { hasHeaderRow: true })).toEqual([
      {
        fields: { word: '나무', meaning: 'tree', notes: 'source: book' },
        tags: ['nature', 'A1', 'noun'],
        cardId: '',
      },
      { fields: { word: '하늘', meaning: 'sky' }, tags: ['nature', 'A1'], cardId: '' },
    ]);
  });

  it('joins a Notes column after text already in Notes', () => {
    const row = applyColumnTargets(
      ['나무', 'own note', 'extra'],
      ['word', 'notes', 'memo2'],
      [
        { kind: 'field', fieldKey: 'word' },
        { kind: 'field', fieldKey: 'notes' },
        { kind: 'notes' },
      ],
      KO,
    );
    expect(row.fields.notes).toBe('own note\nmemo2: extra');
  });
});

describe('stored column maps', () => {
  it('round-trips targets and drops what the note type cannot hold', () => {
    const all: ColumnTarget[] = [
      { kind: 'field', fieldKey: 'word' },
      { kind: 'tags' },
      { kind: 'card_id' },
      { kind: 'notes' },
      { kind: 'ignore' },
    ];
    for (const t of all) expect(decodeColumnTarget(encodeColumnTarget(t), KO)).toEqual(t);
    expect(decodeColumnTarget('field:nope', KO)).toBeUndefined();
    expect(decodeColumnTarget('notes', NO_NOTES)).toBeUndefined();
    expect(decodeColumnTarget('bogus', KO)).toBeUndefined();
  });

  it('matches by header name, ignoring case, order and NFC, repeated headers in order', () => {
    const map = toSourceColumnMap(
      ['Word', 'cat', 'cat', ''],
      [{ kind: 'field', fieldKey: 'word' }, { kind: 'tags' }, { kind: 'notes' }, { kind: 'tags' }],
    );
    expect(map).toEqual([
      { header: 'Word', target: 'field:word' },
      { header: 'cat', target: 'tags' },
      { header: 'cat', target: 'notes' },
    ]);
    expect(resolveSourceColumnMap(['CAT', 'new column', 'word', 'cat'], map, KO)).toEqual([
      { kind: 'tags' },
      undefined,
      { kind: 'field', fieldKey: 'word' },
      { kind: 'notes' },
    ]);
  });

  it('never throws and returns one target per column for any table', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 }), { maxLength: 8 }),
        fc.boolean(),
        (grid, hasHeaderRow) => {
          const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
          const guess = guessColumnMapping(grid, KO, { hasHeaderRow });
          expect(guess.columns).toHaveLength(width);
          const fieldKeys = guess.columns
            .map((c) => c.target)
            .filter((t) => t.kind === 'field' && t.fieldKey !== 'notes');
          const keys = fieldKeys.map((t) => (t.kind === 'field' ? t.fieldKey : ''));
          expect(new Set(keys).size).toBe(keys.length);
        },
      ),
    );
  });
});

describe('importers honour an explicit mapping', () => {
  const factory = () => createEventFactory('dev-m', 0, createHlcState('dev-m', 1000));

  it('buildEventsFromCsv uses the columns given, with or without a header row', () => {
    const csv = [
      'word,definition,example,category1,category2,source',
      '나무,tree,나무가 커요.,nature,A1,book',
    ].join('\n');
    const targets = guessColumnMapping(
      csv.split('\n').map((l) => l.split(',')),
      KO,
    ).columns.map((c) => c.target);
    const res = buildEventsFromCsv(csv, {
      deckId: 'deck-1',
      noteType: KO,
      eventFactory: factory(),
      columns: targets,
      nowMs: 1000,
    });
    expect(res.warnings).toEqual([]);
    const note = res.events[0];
    expect(note?.type).toBe('NoteUpserted');
    if (note?.type !== 'NoteUpserted') return;
    expect(note.payload.fields).toEqual({
      word: '나무',
      meaning: 'tree',
      example: '나무가 커요.',
      notes: 'source: book',
    });
    expect(note.payload.tags).toEqual(['nature', 'A1']);

    const headerless = buildEventsFromCsv('나무,tree\n하늘,sky', {
      deckId: 'deck-1',
      noteType: KO,
      eventFactory: factory(),
      columns: [
        { kind: 'field', fieldKey: 'word' },
        { kind: 'field', fieldKey: 'meaning' },
      ],
      hasHeaderRow: false,
      nowMs: 1000,
    });
    expect(headerless.importedCount).toBe(2);
  });

  it('without a mapping, the "definition" column is still dropped (name matching only)', () => {
    const res = buildEventsFromCsv('word,definition\n나무,tree', {
      deckId: 'deck-1',
      noteType: KO,
      eventFactory: factory(),
      nowMs: 1000,
    });
    expect(res.warnings.map((w) => w.code)).toEqual(['unknown_header']);
  });

  it('diffTabularSource applies a saved column map on refresh and keeps new columns by name', () => {
    const state = createEmptyState();
    const f = factory();
    applyEvents(state, [
      f.create(
        'DeckCreated',
        { deck_id: 'deck-s', name: 'S', note_type_id: KO.id, language: 'ko', created_at: 1000 },
        1000,
      ),
    ]);
    const columnMap = toSourceColumnMap(
      ['word', 'definition', 'category1', 'Card ID'],
      [
        { kind: 'field', fieldKey: 'word' },
        { kind: 'field', fieldKey: 'meaning' },
        { kind: 'tags' },
        { kind: 'card_id' },
      ],
    );
    const res = diffTabularSource({
      deckId: 'deck-s',
      noteType: KO,
      state,
      eventFactory: f,
      // Columns reordered in the Sheet, and an "Example" column added later.
      grid: [
        ['Card ID', 'Example', 'category1', 'definition', 'word'],
        ['c-1', '나무가 커요.', 'nature', 'tree', '나무'],
      ],
      identityMode: 'card_id',
      canWriteBack: false,
      columnMap,
      nowMs: 2000,
    });
    const upsert = res.events.find((e) => e.type === 'NoteUpserted');
    if (upsert?.type !== 'NoteUpserted') throw new Error('no note');
    expect(upsert.payload.source_key).toBe('c-1');
    expect(upsert.payload.fields).toEqual({
      word: '나무',
      meaning: 'tree',
      example: '나무가 커요.',
    });
    expect(upsert.payload.tags).toEqual(['nature']);
  });

  it('keeps Japanese decks on their own fields', () => {
    const grid = [
      ['word', 'reading', 'definition'],
      ['食べる', 'たべる', 'to eat'],
    ];
    expect(targetsOf(grid, JA)).toEqual(['field:word', 'field:reading', 'field:meaning']);
  });
});

describe('guessColumnMapping: header and value edge cases', () => {
  it('drops a trailing number from a header, with or without a space', () => {
    const grid = [
      ['Word 1', '예문1', 'Category 12', 'meaning'],
      ['나무', '나무가 커요.', 'nature', 'tree'],
    ];
    expect(targetsOf(grid, KO, true)).toEqual([
      'field:word',
      'field:example',
      'tags',
      'field:meaning',
    ]);
  });

  it('handles a header that is a long run of digits quickly', () => {
    const header = `${'1'.repeat(20_000)}x${'2'.repeat(20_000)}`;
    const started = Date.now();
    const guess = guessColumnMapping(
      [
        ['word', header],
        ['나무', 'tree'],
      ],
      KO,
      {
        hasHeaderRow: true,
      },
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(guess.columns[0]?.target).toEqual({ kind: 'field', fieldKey: 'word' });
  });

  it('spots image URLs (with a query string) but not other file URLs', () => {
    const grid = [
      ['word', 'pic', 'doc'],
      ['고양이', 'https://example.com/cat.JPG?w=200', 'https://example.com/cat.pdf'],
      ['개', 'https://example.com/dog.webp', 'https://example.com/dog.pdf'],
    ];
    const [, pic, doc] = guessColumnMapping(grid, KO, { hasHeaderRow: true }).columns;
    expect(pic?.target).toEqual({ kind: 'field', fieldKey: 'image' });
    expect(pic?.reason).toBe('content');
    expect(doc?.target).not.toEqual({ kind: 'field', fieldKey: 'image' });
  });
});
