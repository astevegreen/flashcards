import { describe, expect, it } from 'vitest';
import { sha1First32 } from '../src/export/anki/checksum.ts';
import { ankiStripHtmlForSort } from '../src/export/anki/apkg.ts';
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

  it('writes sfld and csum the way Anki strips HTML (no trim, <br> deleted, entities decoded)', () => {
    expect(ankiStripHtmlForSort('a<br>b')).toBe('ab');
    expect(ankiStripHtmlForSort(' <img src="x.png"> ')).toBe('  x.png  ');
    expect(ankiStripHtmlForSort('&#39;&#160;&apos;&#x41;&amp;lt;<!-- c -->')).toBe("' 'A&lt;");
    const plan = planAnkiApkgExport(buildAnkiExportState(), { nowMs: T0, deckIds: [VOCAB_DECK] });
    const notes = plan.collection.tables.find((t) => t.name === 'notes')?.rows ?? [];
    // note-2's Word field is `test&#91;abc&#93; &amp;&#32; 今日[きょう]` in the package.
    const sortText = 'test[abc] &  今日[きょう]';
    expect(notes[1]?.[7]).toBe(sortText);
    expect(notes[1]?.[8]).toBe(sha1First32(encodeUtf8(sortText)));
    expect(plan.fromAnkiNoteCount).toBe(1);
  });

  it('gives a note type imported from Anki its Anki id back, with templates in Anki order', () => {
    const state = buildAnkiExportState();
    const deck = state.decks.get(VOCAB_DECK);
    const vocab = deck ? state.noteTypes.get(deck.note_type_id) : undefined;
    if (!deck || !vocab) throw new Error('fixture');
    const mid = 1_342_697_561_419;
    const id = `anki:nt:${mid}`;
    state.noteTypes.set(id, { ...vocab, id });
    state.decks.set(VOCAB_DECK, { ...deck, note_type_id: id });
    for (const layout of [...state.layouts.values()]) {
      if (layout.note_type_id !== vocab.id) continue;
      state.layouts.delete(layout.id);
    }
    for (const ord of [10, 2]) {
      const layoutId = `anki:layout:${mid}:${ord}`;
      state.layouts.set(layoutId, {
        ...CLOZE_LAYOUT,
        id: layoutId,
        name: `Card ${ord}`,
        note_type_id: id,
        answer_mode: 'flip',
      });
    }
    const plan = planAnkiApkgExport(state, { nowMs: T0, deckIds: [VOCAB_DECK] });
    const col = plan.collection.tables.find((t) => t.name === 'col')?.rows[0] ?? [];
    const models = JSON.parse(String(col[9])) as Record<string, { tmpls: Array<{ name: string }> }>;
    expect(Object.keys(models)).toEqual([String(mid)]);
    expect(models[String(mid)]?.tmpls.map((t) => t.name)).toEqual(['Card 2', 'Card 10']);
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
