import { describe, expect, it } from 'vitest';
import { applyEvents, createEmptyState, createEventFactory } from '../src/events/replay.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS, BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';
import {
  duplicateKeyField,
  findDuplicateGroups,
  normalizeDuplicateKey,
} from '../src/tags/duplicates.ts';

const BASE = Date.UTC(2026, 10, 1, 1, 0, 0);

function buildState() {
  const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
  let t = BASE;
  const events: FlashEvent[] = [];
  const deck = (id: string, name: string, noteType: string, language: string) =>
    events.push(
      f.create('DeckCreated', { deck_id: id, name, note_type_id: noteType, language }, (t += 1)),
    );
  const note = (deckId: string, key: string, fields: Record<string, string>) =>
    events.push(
      f.create(
        'NoteUpserted',
        { note_id: deriveNoteId(deckId, key), deck_id: deckId, source_key: key, fields },
        (t += 1),
      ),
    );
  deck('mine-ja', 'My Japanese', BUILTIN_NOTE_TYPE_IDS.VOCAB_JA, 'ja');
  deck('jlpt-n5', 'JLPT N5', BUILTIN_NOTE_TYPE_IDS.VOCAB_JA, 'ja-JP');
  deck('hsk-1', 'HSK 1', BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH, 'zh-Hans');
  deck('mine-ko', 'My Korean', BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, 'ko');
  deck('topik', 'TOPIK I', BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, 'ko');
  // Ruby markup and padding on one side.
  note('mine-ja', 'a', { word: ' 学校[がっこう] ', meaning: 'school' });
  note('jlpt-n5', 'a', { word: '学校', meaning: 'school (N5)' });
  // Same characters in Chinese: another language, no match.
  note('hsk-1', 'a', { word: '学校', meaning: 'school' });
  // NFD vs NFC Hangul, and an inner double space.
  note('mine-ko', 'a', { word: '학교'.normalize('NFD'), meaning: 'school' });
  note('topik', 'a', { word: '학교', meaning: 'school' });
  note('mine-ko', 'b', { word: '좋은  아침' });
  note('topik', 'b', { word: '좋은 아침' });
  // Same deck twice: only without acrossDecksOnly.
  note('topik', 'c', { word: '사과' });
  note('topik', 'd', { word: '사과' });
  // Archived note: left out.
  note('mine-ko', 'e', { word: '물' });
  note('topik', 'e', { word: '물' });
  events.push(f.create('NoteArchived', { note_id: deriveNoteId('topik', 'e') }, (t += 1)));
  // Empty keys never match.
  note('mine-ko', 'f', { word: '  ', meaning: 'x' });
  note('topik', 'f', { word: '', meaning: 'x' });
  return applyEvents(createEmptyState(), events);
}

describe('duplicate finder', () => {
  it('normalizes NFC, trims, collapses spaces and strips ruby', () => {
    expect(normalizeDuplicateKey('  学校[がっこう]  ')).toBe('学校');
    expect(normalizeDuplicateKey('학교'.normalize('NFD'))).toBe('학교');
    expect(normalizeDuplicateKey('a \t b')).toBe('a b');
    expect(normalizeDuplicateKey('Apple')).not.toBe(normalizeDuplicateKey('apple'));
  });

  it('uses the sort-key field of the note type', () => {
    const ko = BUILTIN_NOTE_TYPES.find((n) => n.id === BUILTIN_NOTE_TYPE_IDS.VOCAB_KO);
    const hanja = BUILTIN_NOTE_TYPES.find((n) => n.id === BUILTIN_NOTE_TYPE_IDS.HANJA);
    expect(duplicateKeyField(ko)).toBe('word');
    expect(duplicateKeyField(hanja)).toBe('character');
    expect(duplicateKeyField(undefined)).toBeUndefined();
  });

  it('groups notes across decks of one language', () => {
    const groups = findDuplicateGroups(buildState());
    expect(groups.map((g) => [g.language, g.key, g.noteIds.length])).toEqual([
      ['ja', '学校', 2],
      ['ko', '좋은 아침', 2],
      ['ko', '학교', 2],
    ]);
    const ja = groups[0];
    // Notes sorted by deck name: "JLPT N5" before "My Japanese".
    expect(ja?.noteIds).toEqual([deriveNoteId('jlpt-n5', 'a'), deriveNoteId('mine-ja', 'a')]);
    expect(ja?.deckIds).toEqual(['jlpt-n5', 'mine-ja']);
  });

  it('can include same-deck duplicates and archived notes', () => {
    const st = buildState();
    const keys = findDuplicateGroups(st, { acrossDecksOnly: false }).map((g) => g.key);
    expect(keys).toContain('사과');
    expect(keys).not.toContain('물');
    expect(findDuplicateGroups(st, { includeArchived: true }).map((g) => g.key)).toContain('물');
  });

  it('leaves out archived decks', () => {
    const st = buildState();
    const f = createEventFactory('dev-a', 100, createHlcState('dev-a', BASE + 1_000));
    applyEvents(st, [
      f.create('DeckSettingsChanged', { deck_id: 'jlpt-n5', archived: true }, BASE + 1_000),
    ]);
    expect(findDuplicateGroups(st).map((g) => g.key)).not.toContain('学校');
  });
});
