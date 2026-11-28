import { describe, expect, it } from 'vitest';
import {
  deckLanguageOffer,
  deckLanguageOfferEvents,
  wasDeckLanguageOffered,
} from '../src/decks/language-offer.ts';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  replayAllEvents,
  type CollectionState,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { FlashEvent, KnownEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { guessCjkLanguageFromText, guessLanguageFromText } from '../src/languages/guess-script.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import { buildSampleDeckEvents } from '../src/samples/decks.ts';
import { buildStarterDeckEvents, loadStarterDeck, STARTER_DECKS } from '../src/starters/index.ts';

const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);

function factoryFor(device = 'dev-a') {
  return createEventFactory(device, 0, createHlcState(device, T0));
}

function deckEvents(
  deckId: string,
  noteTypeId: string,
  language: string,
  notes: Record<string, string>[],
  device = 'dev-a',
): KnownEvent[] {
  const f = factoryFor(device);
  return [
    f.create(
      'DeckCreated',
      { deck_id: deckId, name: deckId, note_type_id: noteTypeId, language },
      T0,
    ),
    ...notes.map((fields, i) =>
      f.create(
        'NoteUpserted',
        { note_id: `${deckId}-n${i}`, deck_id: deckId, source_key: `k${i}`, fields },
        T0 + i + 1,
      ),
    ),
  ];
}

function stateOf(events: readonly FlashEvent[]): CollectionState {
  const state = createEmptyState();
  applyEvents(state, events);
  return state;
}

/** The offer for the deck with id `deckId`, which must exist. */
function offerFor(state: CollectionState, deckId: string): string | undefined {
  const deck = state.decks.get(deckId);
  if (!deck) throw new Error(`no deck ${deckId}`);
  return deckLanguageOffer(state, deck);
}

const KO_SENTENCES = [
  { sentence: '저는 학생이에요.', translation: 'I am a student.' },
  { sentence: '커피 주세요.', translation: 'Coffee, please.' },
];

describe('guessCjkLanguageFromText', () => {
  it('names the script of mostly-CJK text and keeps guessLanguageFromText as it was', () => {
    expect(guessCjkLanguageFromText(['저는 학생이에요.'])).toBe('ko');
    expect(guessCjkLanguageFromText(['私は{{c1::学生}}です。'])).toBe('ja');
    expect(guessCjkLanguageFromText(['我是学生。'])).toBe('zh-Hans');
    expect(guessCjkLanguageFromText(['I am a student.'])).toBeUndefined();
    expect(guessCjkLanguageFromText(['The word 학생 means student.'])).toBeUndefined();
    expect(guessCjkLanguageFromText(['', '123 ...'])).toBeUndefined();
    expect(guessLanguageFromText(['The word 학생 means student.'])).toBe('ko');
    expect(guessLanguageFromText(['I am a student.'])).toBe('en');
  });
});

describe('deckLanguageOffer', () => {
  it('offers the detected language for a Sentence, Cloze or Grammar deck left on en', () => {
    const state = stateOf([
      ...deckEvents('s', BUILTIN_NOTE_TYPE_IDS.SENTENCE, 'en', KO_SENTENCES),
      ...deckEvents('c', BUILTIN_NOTE_TYPE_IDS.CLOZE, 'en', [{ text: '私は{{c1::学生}}です。' }]),
      ...deckEvents('g', BUILTIN_NOTE_TYPE_IDS.GRAMMAR, 'en', [
        { pattern: '是…的', example: '我是昨天来的。', explanation: 'Stresses when.' },
      ]),
    ]);
    expect(offerFor(state, 's')).toBe('ko');
    expect(offerFor(state, 'c')).toBe('ja');
    expect(offerFor(state, 'g')).toBe('zh-Hans');
  });

  it('offers nothing when the language matches, the text is Latin, or the type is not neutral', () => {
    const state = stateOf([
      ...deckEvents('match', BUILTIN_NOTE_TYPE_IDS.SENTENCE, 'ko-KR', KO_SENTENCES),
      ...deckEvents('hant', BUILTIN_NOTE_TYPE_IDS.SENTENCE, 'zh-Hant', [
        { sentence: '我是學生。' },
      ]),
      ...deckEvents('latin', BUILTIN_NOTE_TYPE_IDS.SENTENCE, 'ko', [{ sentence: 'I am here.' }]),
      ...deckEvents('vocab', BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, 'en', [{ term: '학생' }]),
      ...deckEvents('empty', BUILTIN_NOTE_TYPE_IDS.SENTENCE, 'en', []),
      // Only the translation is Korean: the sentence field decides.
      ...deckEvents('tr', BUILTIN_NOTE_TYPE_IDS.SENTENCE, 'en', [
        { sentence: 'Good morning.', translation: '좋은 아침이에요.' },
      ]),
    ]);
    for (const id of ['match', 'hant', 'latin', 'vocab', 'empty', 'tr']) {
      expect(offerFor(state, id), id).toBeUndefined();
    }
  });

  it('skips archived decks and archived notes', () => {
    const f = factoryFor('dev-x');
    const events = [
      ...deckEvents('s', BUILTIN_NOTE_TYPE_IDS.SENTENCE, 'en', KO_SENTENCES),
      f.create('NoteArchived', { note_id: 's-n0' }, T0 + 10),
      f.create('NoteArchived', { note_id: 's-n1' }, T0 + 11),
    ];
    expect(offerFor(stateOf(events), 's')).toBeUndefined();
    const archived = stateOf([
      ...deckEvents('s', BUILTIN_NOTE_TYPE_IDS.SENTENCE, 'en', KO_SENTENCES),
      f.create('DeckSettingsChanged', { deck_id: 's', archived: true }, T0 + 10),
    ]);
    expect(offerFor(archived, 's')).toBeUndefined();
  });

  it('taking the offer sets the language by event and the offer never returns', () => {
    const base = deckEvents('s', BUILTIN_NOTE_TYPE_IDS.SENTENCE, 'en', KO_SENTENCES);
    const state = stateOf(base);
    const answer = deckLanguageOfferEvents(factoryFor('dev-b'), 's', 'ko', true, T0 + 100);
    expect(answer.map((e) => e.type)).toEqual(['DeckSettingsChanged', 'DeckLanguageOffered']);
    applyEvents(state, answer);
    expect(state.decks.get('s')?.language).toBe('ko');
    expect(wasDeckLanguageOffered(state, 's')).toBe(true);
    expect(offerFor(state, 's')).toBeUndefined();

    // Undo (a later DeckSettingsChanged back to en) does not bring the offer back.
    applyEvents(state, [
      factoryFor('dev-b').create('DeckSettingsChanged', { deck_id: 's', language: 'en' }, T0 + 200),
    ]);
    expect(state.decks.get('s')?.language).toBe('en');
    expect(offerFor(state, 's')).toBeUndefined();
  });

  it('a dismissal survives replay in any order, duplication and a snapshot round trip', () => {
    const base = deckEvents('s', BUILTIN_NOTE_TYPE_IDS.SENTENCE, 'en', KO_SENTENCES);
    const dismiss = deckLanguageOfferEvents(factoryFor('dev-b'), 's', 'ko', false, T0 + 100);
    expect(dismiss.map((e) => e.type)).toEqual(['DeckLanguageOffered']);

    for (const log of [
      [...base, ...dismiss],
      [...dismiss, ...base],
      [...dismiss, ...base, ...dismiss],
    ]) {
      const state = replayAllEvents(log);
      expect(state.decks.get('s')?.language).toBe('en');
      expect(offerFor(state, 's')).toBeUndefined();
    }

    const hydrated = deserializeCollectionState(
      JSON.parse(JSON.stringify(serializeCollectionState(stateOf([...base, ...dismiss])))),
    );
    expect(offerFor(hydrated, 's')).toBeUndefined();
    // And the deck is offered on a fresh device that has not seen the dismissal yet.
    const fresh = stateOf(base);
    expect(offerFor(fresh, 's')).toBe('ko');
  });

  it('offers nothing for the sample decks or any starter deck', async () => {
    const events: KnownEvent[] = buildSampleDeckEvents(factoryFor());
    for (const info of STARTER_DECKS) {
      events.push(...buildStarterDeckEvents(factoryFor(), info, await loadStarterDeck(info.slug)));
    }
    const state = stateOf(events);
    expect(state.decks.size).toBeGreaterThan(0);
    for (const deck of state.decks.values()) {
      expect(deckLanguageOffer(state, deck), deck.id).toBeUndefined();
    }
  });
});
