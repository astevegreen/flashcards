import { describe, expect, it } from 'vitest';
import {
  BUILTIN_LAYOUTS,
  BUILTIN_NOTE_TYPE_IDS,
  BUILTIN_NOTE_TYPES,
  deckNoteType,
  guessLanguageFromText,
  noteTypeForDeck,
  resolveCardAudioTarget,
  type Deck,
  type Note,
  type NoteType,
} from '../src/index.ts';
import { inferPresetNoteTypeId } from '../src/sources/tabular.ts';

function preset(id: string): NoteType {
  const nt = BUILTIN_NOTE_TYPES.find((t) => t.id === id);
  if (!nt) throw new Error(`no preset ${id}`);
  return nt;
}

function deck(language: string, noteTypeId: string): Deck {
  return {
    id: `d-${language}`,
    name: language,
    note_type_id: noteTypeId,
    language,
    settings: {
      new_cards_per_day: 20,
      max_reviews_per_day: 200,
      target_retention: 0.9,
      new_card_order: 'source',
    },
    initial_retention: 0.9,
    archived: false,
    created_at: 1000,
  };
}

const langOf = (nt: NoteType, key: string) => nt.fields.find((f) => f.key === key)?.lang;

describe('noteTypeForDeck (C8)', () => {
  it("gives the Sentence preset's target fields the deck's language", () => {
    const ko = noteTypeForDeck(preset(BUILTIN_NOTE_TYPE_IDS.SENTENCE), 'ko');
    expect(langOf(ko, 'sentence')).toBe('ko');
    expect(langOf(ko, 'reading')).toBe('ko');
    expect(langOf(ko, 'audio')).toBe('ko');
    expect(langOf(ko, 'translation')).toBe('en');
    expect(langOf(ko, 'notes')).toBe('en');
  });

  it('does the same for Cloze and Grammar, and tags a Chinese reading as pinyin', () => {
    expect(langOf(noteTypeForDeck(preset(BUILTIN_NOTE_TYPE_IDS.CLOZE), 'ko'), 'text')).toBe('ko');
    const grammarJa = noteTypeForDeck(preset(BUILTIN_NOTE_TYPE_IDS.GRAMMAR), 'ja');
    expect(langOf(grammarJa, 'pattern')).toBe('ja');
    expect(langOf(grammarJa, 'example')).toBe('ja');
    expect(langOf(grammarJa, 'explanation')).toBe('en');
    const zh = noteTypeForDeck(preset(BUILTIN_NOTE_TYPE_IDS.SENTENCE), 'zh-Hans');
    expect(langOf(zh, 'sentence')).toBe('zh-Hans');
    expect(langOf(zh, 'reading')).toBe('zh-Latn-pinyin');
  });

  it('leaves language-bound and unchanged types as the same object, and caches the rest', () => {
    const vocab = preset(BUILTIN_NOTE_TYPE_IDS.VOCAB_JA);
    expect(noteTypeForDeck(vocab, 'ko')).toBe(vocab);
    const cloze = preset(BUILTIN_NOTE_TYPE_IDS.CLOZE);
    expect(noteTypeForDeck(cloze, 'ja')).toBe(cloze);
    expect(noteTypeForDeck(cloze, undefined)).toBe(cloze);
    expect(noteTypeForDeck(cloze, 'ko')).toBe(noteTypeForDeck(cloze, 'ko'));
  });

  it("keeps a field language someone set over the deck's language", () => {
    const base = preset(BUILTIN_NOTE_TYPE_IDS.SENTENCE);
    // As a synced or restored NoteTypeChanged leaves it: the reading tagged as romanization.
    const edited: NoteType = {
      ...base,
      fields: base.fields.map((f) => (f.key === 'reading' ? { ...f, lang: 'ko-Latn' } : f)),
    };
    const ko = noteTypeForDeck(edited, 'ko');
    expect(langOf(ko, 'reading')).toBe('ko-Latn');
    expect(langOf(ko, 'sentence')).toBe('ko');
    expect(langOf(noteTypeForDeck(edited, 'zh-Hans'), 'reading')).toBe('ko-Latn');
    // Every target field set by hand: nothing left for the deck to change.
    const allSet: NoteType = {
      ...base,
      fields: base.fields.map((f) => ({ ...f, lang: f.lang === 'en' ? 'fr' : f.lang })),
    };
    expect(noteTypeForDeck(allSet, 'ko')).toBe(allSet);
  });

  it('deckNoteType looks the note type up for a deck', () => {
    const sentence = preset(BUILTIN_NOTE_TYPE_IDS.SENTENCE);
    const state = { noteTypes: new Map([[sentence.id, sentence]]) };
    expect(deckNoteType(state, deck('ko', sentence.id))?.fields[0]?.lang).toBe('ko');
    expect(deckNoteType(state, undefined)).toBeUndefined();
    expect(deckNoteType(state, deck('ko', 'missing'))).toBeUndefined();
  });

  it('speaks a Korean sentence with a Korean voice', () => {
    const sentence = preset(BUILTIN_NOTE_TYPE_IDS.SENTENCE);
    const layout = BUILTIN_LAYOUTS.find((l) => l.id === 'layout:sentence:recognition');
    if (!layout) throw new Error('no sentence layout');
    const d = deck('ko', sentence.id);
    const note: Note = {
      id: 'n1',
      deck_id: d.id,
      fields: { sentence: '저는 학생이에요.', translation: 'I am a student.' },
      tags: [],
      source_key: 'k1',
      provenance: { source: 'user', reviewed: true },
      archived: false,
      created_order: 0,
    };
    const target = resolveCardAudioTarget(note, layout, sentence, d);
    expect(target.sourceField).toBe('sentence');
    expect(target.lang).toBe('ko');
    expect(target.bcp47Lang).toBe('ko-KR');
  });
});

describe('guessLanguageFromText', () => {
  it('reads the script', () => {
    expect(guessLanguageFromText(['저는 학생이에요.'])).toBe('ko');
    expect(guessLanguageFromText(['私は学生です。'])).toBe('ja');
    expect(guessLanguageFromText(['我是学生。'])).toBe('zh-Hans');
    expect(guessLanguageFromText(['I am a student.'])).toBe('en');
    expect(guessLanguageFromText(['', '123 ...'])).toBeUndefined();
    expect(guessLanguageFromText(['한국어 (Korean)'])).toBe('ko');
  });
});

describe('inferPresetNoteTypeId for sentence tables', () => {
  it('takes the language from the sentence column', () => {
    const headers = ['Sentence', 'Translation'];
    const rows = [
      ['저는 학생이에요.', 'I am a student.'],
      ['감사합니다.', 'Thank you.'],
    ];
    expect(inferPresetNoteTypeId(headers, undefined, rows)).toEqual({
      noteTypeId: BUILTIN_NOTE_TYPE_IDS.SENTENCE,
      language: 'ko',
    });
    expect(inferPresetNoteTypeId(headers).language).toBe('en');
    expect(inferPresetNoteTypeId(['Translation'], undefined, rows).language).toBe('en');
  });
});
