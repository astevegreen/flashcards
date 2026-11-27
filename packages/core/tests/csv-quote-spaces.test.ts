import { describe, expect, it } from 'vitest';
import { applyEvents, createEmptyState, createEventFactory } from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { previewMappedRows, type ColumnTarget } from '../src/import/column-mapping.ts';
import {
  buildEventsFromCsv,
  exportCsv,
  parseDelimitedTable,
  parseDelimitedText,
} from '../src/import/csv.ts';
import { BUILTIN_NOTE_TYPE_IDS, BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';
import type { NoteType } from '../src/model/types.ts';

const KO = BUILTIN_NOTE_TYPES.find((nt) => nt.id === BUILTIN_NOTE_TYPE_IDS.VOCAB_KO) as NoteType;

function importFields(text: string, options: { hasHeaderRow?: boolean } = {}) {
  const res = buildEventsFromCsv(text, {
    deckId: 'deck-q',
    noteType: KO,
    eventFactory: createEventFactory('dev-q', 0, createHlcState('dev-q', 1000)),
    nowMs: 2000,
    ...(options.hasHeaderRow === undefined ? {} : { hasHeaderRow: options.hasHeaderRow }),
    ...(options.hasHeaderRow === false
      ? {
          columns: [
            { kind: 'field', fieldKey: 'word' },
            { kind: 'field', fieldKey: 'meaning' },
          ] satisfies ColumnTarget[],
        }
      : {}),
  });
  return res.events.map((e) => (e.type === 'NoteUpserted' ? e.payload.fields : {}));
}

describe('a space before an opening quote (RFC-tolerant)', () => {
  it('reads `a, "b"` like `a,"b"`', () => {
    expect(parseDelimitedText('h1,h2\na, "b, c"\n').rows).toEqual([['a', 'b, c']]);
    expect(parseDelimitedText('h1,h2\na,  "x ""y"""\n').rows).toEqual([['a', 'x "y"']]);
    // The quoted text keeps its own spaces and the cell counts as quoted.
    const table = parseDelimitedTable('h1,h2\na, " b "\n');
    expect(table.rows).toEqual([['a', ' b ']]);
    expect(table.quoted).toEqual([[false, true]]);
  });

  it('imports the cell as a quoted one', () => {
    expect(importFields('word,meaning\n나무, " tree "\n')).toEqual([
      { word: '나무', meaning: ' tree ' },
    ]);
  });

  it('keeps the spaces and the quote when the quote turns out to be text', () => {
    // Never closes: the field is read again as plain text, spaces included.
    expect(parseDelimitedText('h1,h2\na, "b\nc,d\n').rows).toEqual([
      ['a', ' "b'],
      ['c', 'd'],
    ]);
    // Text after the closing quote: the same.
    expect(parseDelimitedText('h1,h2\na, "b" c\n').rows).toEqual([['a', ' "b" c']]);
  });

  it('does not open a quote after other text, or in the middle of a TSV cell', () => {
    expect(parseDelimitedText('h1,h2\na,x "b"\n').rows).toEqual([['a', 'x "b"']]);
    expect(parseDelimitedText('h1\th2\na\t "b"\n', { delimiter: '\t' }).rows).toEqual([['a', 'b']]);
  });
});

describe('a quoted cell of spaces only', () => {
  it('imports as the spaces, not as empty', () => {
    expect(importFields('word,meaning\n나무,"   "\n')).toEqual([{ word: '나무', meaning: '   ' }]);
    // Unquoted, it is still empty.
    expect(importFields('word,meaning\n나무,   \n')).toEqual([{ word: '나무' }]);
  });

  it('round-trips through exportCsv', () => {
    const factory = createEventFactory('dev-r', 0, createHlcState('dev-r', 1000));
    const state = applyEvents(createEmptyState(), [
      factory.create(
        'DeckCreated',
        { deck_id: 'deck-r', name: 'R', note_type_id: KO.id, language: 'ko' },
        1000,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: 'note-r',
          deck_id: 'deck-r',
          source_key: 'r-1',
          fields: { word: '나무', meaning: '   ' },
          tags: [],
        },
        1000,
      ),
    ]);
    const csv = exportCsv(state, { deckId: 'deck-r' });
    const fields = buildEventsFromCsv(csv.text, {
      deckId: 'deck-r',
      noteType: KO,
      eventFactory: factory,
      nowMs: 2000,
      existingNotes: state.notes.values(),
    }).events.map((e) => (e.type === 'NoteUpserted' ? e.payload.fields : {}));
    expect(fields).toEqual([{ word: '나무', meaning: '   ' }]);
  });
});

describe('the Bring my cards preview reads quotes like the import', () => {
  const targets: ColumnTarget[] = [
    { kind: 'field', fieldKey: 'word' },
    { kind: 'field', fieldKey: 'meaning' },
  ];

  function preview(text: string, hasHeaderRow: boolean) {
    const t = parseDelimitedTable(text);
    const grid = [t.headers, ...t.rows];
    const quotes = { quoted: [t.firstQuoted, ...t.quoted], firstRow: t.firstRow };
    return previewMappedRows(grid, targets, KO, { hasHeaderRow, quotes }).map((r) => r.fields);
  }

  it('keeps quoted padding and quoted spaces, trims unquoted cells', () => {
    const text = 'word,meaning\n" 나무 ", tree \n하늘,"   "\n';
    expect(preview(text, true)).toEqual(importFields(text));
    expect(preview(text, true)).toEqual([
      { word: ' 나무 ', meaning: 'tree' },
      { word: '하늘', meaning: '   ' },
    ]);
  });

  it('reads row 1 untrimmed when it is data', () => {
    const text = '" 나무 ",tree\n하늘,sky\n';
    expect(preview(text, false)).toEqual(importFields(text, { hasHeaderRow: false }));
    expect(preview(text, false)[0]).toEqual({ word: ' 나무 ', meaning: 'tree' });
  });

  it('without quote flags (a Sheet grid) every cell is trimmed, as before', () => {
    const grid = [
      ['word', 'meaning'],
      [' 나무 ', '   '],
    ];
    expect(previewMappedRows(grid, targets, KO, { hasHeaderRow: true })).toEqual([
      { fields: { word: '나무' }, tags: [], cardId: '' },
    ]);
  });
});
