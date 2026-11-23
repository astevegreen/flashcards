import { describe, expect, it } from 'vitest';
import { applyEvents, createEmptyState, createEventFactory } from '../src/events/replay.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS, BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';
import { createBulkEvents, planBulkNoteAction } from '../src/tags/bulk.ts';
import {
  DUPLICATE_TAG,
  duplicateKeyField,
  findDuplicateGroups,
  normalizeDuplicateKey,
  planDuplicateTagAdds,
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

  it('folds width variants and compatibility jamo, but not other compatibility symbols', () => {
    // Full-width Latin and digits, half-width katakana (with a separate voiced mark).
    expect(normalizeDuplicateKey('ＡＢＣ１２')).toBe('ABC12');
    expect(normalizeDuplicateKey('ｶﾞｯｺｳ')).toBe('ガッコウ');
    // Half-width Hangul and compatibility jamo fold to the same standard jamo.
    expect(normalizeDuplicateKey('ㄱ')).toBe(normalizeDuplicateKey('ﾡ'));
    expect(normalizeDuplicateKey('ㄱ')).toBe('ᄀ');
    // A CJK compatibility ideograph is a canonical singleton: NFC already maps it.
    expect(normalizeDuplicateKey('豈')).toBe('豈');
    // Circled numbers and unit squares are left alone (no blanket NFKC).
    expect(normalizeDuplicateKey('①')).toBe('①');
    expect(normalizeDuplicateKey('㎏')).toBe('㎏');
  });

  it('strips {base|reading} ruby, and keys Korean ruby on the Hangul side', () => {
    expect(normalizeDuplicateKey('{今日|きょう}', 'ja')).toBe('今日');
    expect(normalizeDuplicateKey('{日本|に|ほん}語', 'ja')).toBe('日本語');
    expect(normalizeDuplicateKey('學校[학교]', 'ko')).toBe('학교');
    expect(normalizeDuplicateKey('{學校|학교}', 'ko')).toBe('학교');
    expect(normalizeDuplicateKey('{학교|學校}', 'ko')).toBe('학교');
    // Outside Korean decks the base stays.
    expect(normalizeDuplicateKey('學校[학교]', 'ja')).toBe('學校');
  });

  it('puts two note types of one language in the same bucket', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const events: FlashEvent[] = [
      f.create(
        'DeckCreated',
        {
          deck_id: 'vocab',
          name: 'Vocab',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
        },
        BASE,
      ),
      f.create(
        'DeckCreated',
        {
          deck_id: 'hanja',
          name: 'Hanja',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.HANJA,
          language: 'ko-KR',
        },
        BASE + 1,
      ),
      f.create(
        'NoteUpserted',
        { note_id: 'n-vocab', deck_id: 'vocab', source_key: 'a', fields: { word: '학교' } },
        BASE + 2,
      ),
      f.create(
        'NoteUpserted',
        {
          note_id: 'n-hanja',
          deck_id: 'hanja',
          source_key: 'a',
          fields: { character: '學校[학교]' },
        },
        BASE + 3,
      ),
    ];
    const groups = findDuplicateGroups(applyEvents(createEmptyState(), events));
    expect(groups).toEqual([
      { key: '학교', language: 'ko', noteIds: ['n-hanja', 'n-vocab'], deckIds: ['hanja', 'vocab'] },
    ]);
  });

  it('tags and archives only the chosen notes', () => {
    const st = buildState();
    const [group] = findDuplicateGroups(st).filter((g) => g.key === '학교');
    const [first, second] = group?.noteIds ?? [];
    if (first === undefined || second === undefined) throw new Error('missing group');

    const adds = planDuplicateTagAdds(st, [first, 'no-such-note']);
    expect(adds).toEqual([{ note_id: first, tags: [DUPLICATE_TAG] }]);
    const f = createEventFactory('dev-a', 500, createHlcState('dev-a', BASE + 5_000));
    applyEvents(
      st,
      adds.map((p) => f.create('NoteTagsAdded', p, BASE + 5_000)),
    );
    expect(st.notes.get(first)?.tags).toContain(DUPLICATE_TAG);
    expect(st.notes.get(second)?.tags).not.toContain(DUPLICATE_TAG);
    // Already tagged: nothing more to add.
    expect(planDuplicateTagAdds(st, [first])).toEqual([]);

    const plan = planBulkNoteAction(st, [second], { kind: 'archive' });
    expect(plan.changedNoteCount).toBe(1);
    applyEvents(st, createBulkEvents(f, plan.events, BASE + 6_000));
    expect(st.notes.get(second)?.archived).toBe(true);
    expect(st.notes.get(first)?.archived).toBe(false);
    expect(findDuplicateGroups(st).map((g) => g.key)).not.toContain('학교');
  });
});
