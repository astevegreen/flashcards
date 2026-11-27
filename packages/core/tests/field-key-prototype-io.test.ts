import { describe, expect, it } from 'vitest';
import { planBackupRestore } from '../src/backup/restore.ts';
import { createEventFactory, replayAllEvents, type CollectionState } from '../src/events/replay.ts';
import type { FlashEvent, NoteUpsertedPayload } from '../src/events/types.ts';
import { planAnkiApkgExport } from '../src/export/anki/apkg.ts';
import { planAnkiCsvExport } from '../src/export/anki/csv.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveNoteId } from '../src/ids.ts';
import { applyColumnTargets } from '../src/import/column-mapping.ts';
import { buildEventsFromCsv } from '../src/import/csv.ts';
import { exportCsv } from '../src/import/csv-export.ts';
import type { NoteType } from '../src/model/types.ts';
import { computeNoteContentHash } from '../src/sources/content-hash.ts';
import { diffTabularSource } from '../src/sources/tabular.ts';
import { planFindReplace } from '../src/tags/find-replace.ts';

// The import/export half of the S4 sweep (see `field-key-prototype.test.ts` for replay, study and
// TTS): a note type whose field keys shadow `Object.prototype`, and notes that leave them empty.
// Before the sweep each site read `note.fields[key]` raw and got `Object`'s function back.

const t0 = Date.UTC(2026, 10, 27, 9, 0, 0);
const NATIVE = 'native code';

const NOTE_TYPE: NoteType = {
  id: 'nt-proto',
  name: 'Proto',
  fields: [
    { key: 'toString', label: 'Word', kind: 'text', lang: 'en', sortKey: true },
    { key: 'constructor', label: 'Extra', kind: 'text', lang: 'en' },
    { key: 'meaning', label: 'Meaning', kind: 'text', lang: 'en' },
  ],
};

function collectionEvents(notes: Array<{ key: string; fields: Record<string, string> }>) {
  const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
  let t = t0;
  const events: FlashEvent[] = [
    f.create('NoteTypeChanged', { note_type: NOTE_TYPE }, (t += 1)),
    f.create(
      'LayoutChanged',
      {
        layout: {
          id: 'l-flip',
          note_type_id: 'nt-proto',
          name: 'Flip',
          front_fields: ['meaning'],
          reveal_steps: [['toString', 'constructor']],
          answer_mode: 'flip',
          hide_furigana_on_front: false,
          enabled: true,
        },
      },
      (t += 1),
    ),
    f.create(
      'DeckCreated',
      {
        deck_id: 'd1',
        name: 'Proto',
        note_type_id: 'nt-proto',
        language: 'en',
        settings: { enabled_layout_ids: ['l-flip'] },
      },
      (t += 1),
    ),
  ];
  for (const note of notes) {
    events.push(
      f.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId('d1', note.key),
          deck_id: 'd1',
          source_key: note.key,
          fields: note.fields,
        },
        (t += 1),
      ),
    );
  }
  return { events, factory: f };
}

/** One deck, one note that has only a meaning: `toString` and `constructor` are both missing. */
function bareState(): CollectionState {
  return replayAllEvents(collectionEvents([{ key: 'k1', fields: { meaning: 'school' } }]).events);
}

describe('exports read only the note’s own fields (S4)', () => {
  it('CSV export writes an empty cell for a missing `constructor` / `toString` field', () => {
    const out = exportCsv(bareState(), { deckId: 'd1', bom: false });
    expect(out.text).not.toContain(NATIVE);
    expect(out.text.split('\r\n')[1]).toBe('k1,,,school,');
  });

  it('Anki CSV export writes empty fields instead of Object’s functions', () => {
    const plan = planAnkiCsvExport(bareState(), { deckId: 'd1' });
    expect(plan.text).not.toContain(NATIVE);
    expect(plan.noteCount).toBe(1);
  });

  it('.apkg export builds the note’s fields and ruby check from own fields only', () => {
    const plan = planAnkiApkgExport(bareState(), { nowMs: t0 + 100, deckIds: ['d1'] });
    const notes = plan.collection.tables.find((t) => t.name === 'notes')?.rows ?? [];
    expect(notes).toHaveLength(1);
    expect(String(notes[0]?.[6]).split('\u001f')).toEqual(['', '', 'school']);
    expect(JSON.stringify(plan.collection)).not.toContain(NATIVE);
  });
});

describe('content hashes (S4)', () => {
  // Pinned from the hash before the sweep: ordinary notes must keep byte-identical hashes, or
  // every linked source would see every note as changed.
  it('keeps existing hashes byte-identical', () => {
    expect(
      computeNoteContentHash({ word: '학교', meaning: 'school', notes: '' }, ['b', ' a ', 'a']),
    ).toBe('1d7448125ce2bde8c2f2119f1a0119a4ddbdea40444331b0bc25ddad9ebc97f5');
    expect(computeNoteContentHash({ constructor: 'c', toString: '', Z: 'z', a: '가' }, [])).toBe(
      '4ab7d8e92b86af64681578cb86d4cc56d1e091e1823cf8d4ffd88d42fd98fa1f',
    );
  });

  it('hashes a note without `constructor` like one with it empty', () => {
    expect(computeNoteContentHash({ meaning: 'x' }, [])).toBe(
      computeNoteContentHash({ meaning: 'x', constructor: '' }, []),
    );
  });
});

describe('linked-source diff (S4)', () => {
  function diff(
    state: CollectionState,
    factory: ReturnType<typeof createEventFactory>,
    grid: string[][],
    identityMode: 'card_id' | 'sort_key',
  ) {
    return diffTabularSource({
      deckId: 'd1',
      noteType: NOTE_TYPE,
      state,
      eventFactory: factory,
      grid,
      identityMode,
      canWriteBack: false,
      nowMs: t0 + 1000,
    });
  }

  it('indexes an existing note that lacks the `toString` sort field without throwing', () => {
    const { events, factory } = collectionEvents([{ key: 'k1', fields: { meaning: 'school' } }]);
    const state = replayAllEvents(events);
    const res = diff(
      state,
      factory,
      [
        ['Word', 'Meaning', 'Card ID'],
        ['', 'school', 'k1'],
      ],
      'card_id',
    );
    expect(res.stats.unchanged).toBe(1);
  });

  it('skips an `.xlsx` row with an empty `toString` sort key, and previews missing notes', () => {
    const { events, factory } = collectionEvents([{ key: 'k1', fields: { meaning: 'school' } }]);
    const state = replayAllEvents(events);
    const res = diff(
      state,
      factory,
      [
        ['Word', 'Meaning'],
        ['', 'blank sort key'],
        ['new', 'added'],
      ],
      'sort_key',
    );
    expect(res.stats.skipped).toBe(1);
    expect(res.stats.added).toBe(1);
    const missing = res.reconciliationCandidates?.missingNotes ?? [];
    expect(missing.map((n) => [n.sortKey, n.preview])).toEqual([['k1', ' — school']]);
  });

  it('clears an own `constructor` field the sheet no longer fills, never writing a function', () => {
    const { events, factory } = collectionEvents([
      { key: 'k1', fields: { toString: 'school', constructor: 'old', meaning: 'm' } },
    ]);
    const state = replayAllEvents(events);
    const res = diff(
      state,
      factory,
      [
        ['Word', 'Meaning', 'Card ID'],
        ['school', 'm2', 'k1'],
      ],
      'card_id',
    );
    const upserts = res.events.filter((e) => e.type === 'NoteUpserted');
    expect(upserts.map((e) => (e.payload as NoteUpsertedPayload).fields)).toEqual([
      { toString: 'school', constructor: '', meaning: 'm2' },
    ]);
  });
});

describe('CSV import mapping (S4)', () => {
  it('maps a column to a `constructor` field without joining Object’s function in front', () => {
    const mapped = applyColumnTargets(
      ['v', 'w'],
      ['Extra', 'Word'],
      [
        { kind: 'field', fieldKey: 'constructor' },
        { kind: 'field', fieldKey: 'toString' },
      ],
      NOTE_TYPE,
    );
    expect(mapped.fields).toEqual({ constructor: 'v', toString: 'w' });
  });

  it('imports explicit `constructor` / `toString` columns as plain values', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const res = buildEventsFromCsv('Extra,Word,Card ID\nv,w,k1\n', {
      deckId: 'd1',
      noteType: NOTE_TYPE,
      eventFactory: f,
      nowMs: t0,
      columns: [
        { kind: 'field', fieldKey: 'constructor' },
        { kind: 'field', fieldKey: 'toString' },
        { kind: 'card_id' },
      ],
    });
    const payload = res.events.find((e) => e.type === 'NoteUpserted')?.payload as
      NoteUpsertedPayload | undefined;
    expect(payload?.fields).toEqual({ constructor: 'v', toString: 'w' });
  });
});

describe('find & replace and backup restore (S4)', () => {
  it('find & replace skips a missing `constructor` / `toString` field instead of throwing', () => {
    const state = bareState();
    const plan = planFindReplace(state, state.notes.keys(), { find: 'o', replace: '0' });
    expect(plan.changes.map((c) => [c.fieldKey, c.after])).toEqual([['meaning', 'sch00l']]);
  });

  it('restore clears an own `constructor` field the backup does not have', () => {
    const backup = bareState();
    const { events } = collectionEvents([
      { key: 'k1', fields: { meaning: 'school' } },
      { key: 'k1', fields: { meaning: 'school', constructor: 'later' } },
    ]);
    const current = replayAllEvents(events);
    expect(current.notes.get(deriveNoteId('d1', 'k1'))?.fields).toEqual({
      meaning: 'school',
      constructor: 'later',
    });
    const upserts = planBackupRestore(current, backup, { nowMs: t0 + 1000 }).steps.filter(
      (s) => s.type === 'NoteUpserted',
    );
    expect(upserts.map((s) => (s.payload as NoteUpsertedPayload).fields)).toEqual([
      { meaning: 'school', constructor: '' },
    ]);
  });
});
