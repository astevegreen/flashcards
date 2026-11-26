import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { applyEvents, createEmptyState, createEventFactory } from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { encodeUtf8 } from '../src/ids.ts';
import { importFlashpkg } from '../src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';

function buildPkg(records: readonly object[]): Uint8Array {
  return zipSync({
    'manifest.json': encodeUtf8(
      JSON.stringify({
        package_id: 'pkg:dup',
        name: 'Dup',
        version: '1.0.0',
        format_version: 1,
        languages: ['ko', 'en'],
        decks: [
          {
            id: 'deck-ko',
            name: 'Dup KO',
            file: 'decks/ko.jsonl',
            note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
            language: 'ko',
          },
        ],
      }),
    ),
    'decks/ko.jsonl': encodeUtf8(records.map((r) => JSON.stringify(r)).join('\n') + '\n'),
  });
}

const factory = () => createEventFactory('dev-1', 0, createHlcState('dev-1', 1000));

describe('.flashpkg note record warnings (C9)', () => {
  it('keeps the first of two records with one id and says so', () => {
    const state = createEmptyState();
    const result = importFlashpkg(
      buildPkg([
        { id: 'n1', fields: { word: '물', meaning: 'water' } },
        { id: 'n2', fields: { word: '불', meaning: 'fire' } },
        { id: 'n1', fields: { word: '눈', meaning: 'snow' } },
      ]),
      state,
      factory(),
      { nowMs: 1000 },
    );
    expect(result.notesImported).toBe(2);
    const dup = result.warnings.find((w) => w.code === 'duplicate_note_id');
    expect(dup?.message).toContain('1 note(s) reuse an id');
    expect(dup?.message).toContain('line 3');
    applyEvents(state, result.events);
    const words = [...state.notes.values()].map((n) => n.fields['word']).sort();
    expect(words).toEqual(['물', '불']);
  });

  it('warns when records use header labels instead of field keys', () => {
    const result = importFlashpkg(
      buildPkg([
        { id: 'n1', fields: { Word: '물', Meaning: 'water' } },
        { id: 'n2', fields: { word: '불', meaning: 'fire' } },
      ]),
      createEmptyState(),
      factory(),
      { nowMs: 1000 },
    );
    const blank = result.warnings.find((w) => w.code === 'unknown_field_keys');
    expect(blank?.message).toContain('1 note(s) have no field the note type knows');
    expect(blank?.message).toContain('word');
  });

  it('adds no warning to a clean file', () => {
    const result = importFlashpkg(
      buildPkg([{ id: 'n1', fields: { word: '물', meaning: 'water' } }]),
      createEmptyState(),
      factory(),
      { nowMs: 1000 },
    );
    expect(result.warnings).toEqual([]);
  });
});
