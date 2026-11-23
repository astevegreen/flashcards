import { describe, expect, it } from 'vitest';
import { sha1First32 } from '../src/export/anki/checksum.ts';
import { ANKI_SCHEMA_11, planAnkiApkgExport } from '../src/export/anki/index.ts';
import { encodeUtf8 } from '../src/ids.ts';
import { buildAnkiExportState, CLOZE_LAYOUT, T0, VOCAB_DECK } from './helpers/anki-export-state.ts';

describe('.apkg export plan', () => {
  it('computes the SHA-1 prefix Anki uses for note checksums', () => {
    expect(sha1First32(encodeUtf8(''))).toBe(0xda39a3ee);
    expect(sha1First32(encodeUtf8('abc'))).toBe(0xa9993e36);
    expect(sha1First32(encodeUtf8('a'.repeat(1000)))).toBe(0x291e9a6c);
  });

  it('plans schema 11 rows: one note row per note, one card per layout, new cards in order', () => {
    const plan = planAnkiApkgExport(buildAnkiExportState(), { nowMs: T0, deckIds: [VOCAB_DECK] });
    expect(plan.collection.schema).toEqual([...ANKI_SCHEMA_11]);
    const table = (name: string) => plan.collection.tables.find((t) => t.name === name);
    const notes = table('notes')?.rows ?? [];
    const cards = table('cards')?.rows ?? [];
    expect(notes).toHaveLength(3);
    expect(cards).toHaveLength(6);
    expect(plan.fileName).toBe('japanese-vocab.apkg');
    // guid, tags with surrounding spaces, fields joined by \x1f
    expect(notes[0]?.[1]).toBe('note-1');
    expect(notes[0]?.[5]).toBe(' jlpt_n5 grammar::verbs ');
    expect(String(notes[0]?.[6]).split('\u001f')).toHaveLength(5);
    // due = note position; one suspended card (queue -1)
    expect(cards.map((c) => c[8])).toEqual([1, 1, 2, 2, 3, 3]);
    expect(cards.filter((c) => c[7] === -1)).toHaveLength(1);
    const col = table('col')?.rows[0] ?? [];
    const decks = Object.values(JSON.parse(String(col[10]))) as Array<{ name: string }>;
    expect(decks.map((d) => d.name).sort()).toEqual(['Default', 'Japanese', 'Japanese::Vocab']);
  });

  it('warns when a note type mixes a cloze layout with other layouts', () => {
    const state = buildAnkiExportState();
    state.layouts.set('extra-flip', {
      ...CLOZE_LAYOUT,
      id: 'extra-flip',
      name: 'Flip',
      answer_mode: 'flip',
    });
    const plan = planAnkiApkgExport(state, { nowMs: T0 });
    expect(plan.warnings.join(' ')).toContain('cloze');
  });
});
