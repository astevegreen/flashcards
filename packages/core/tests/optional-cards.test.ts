import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  type CollectionState,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../src/ids.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import { isFieldFilled, layoutRuleMet, requiredFieldProblem } from '../src/model/optional-cards.ts';
import {
  BUILTIN_LAYOUTS,
  BUILTIN_NOTE_TYPE_IDS,
  BUILTIN_NOTE_TYPES,
} from '../src/model/presets.ts';
import type { Card, Layout, ReviewRating } from '../src/model/types.ts';
import { getCardStateKinds, filterCards } from '../src/study/filter.ts';
import { buildStudyQueue } from '../src/study/queue.ts';

const DECK = 'deck-ko-optional';
const RECOG = 'layout:vocab-ko:recognition';
const LISTEN = 'layout:custom:preset:vocab-ko:listen:test';
const NOTE_KEYS = ['학교', '도서관', '약속'];
const noteIdFor = (i: number) => deriveNoteId(DECK, NOTE_KEYS[i] ?? '');
const listenCardFor = (i: number) => deriveCardId(noteIdFor(i), LISTEN, 0);
const recogCardFor = (i: number) => deriveCardId(noteIdFor(i), RECOG, 0);

const LISTEN_LAYOUT: Layout = {
  id: LISTEN,
  note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
  name: 'Listen',
  front_fields: ['audio'],
  reveal_steps: [['word', 'meaning']],
  answer_mode: 'listen',
  hide_furigana_on_front: false,
  enabled: true,
  required_field: 'audio',
};

const BASE = Date.UTC(2026, 10, 1, 1, 0, 0);

function setupEvents(f: ReturnType<typeof createEventFactory>, audio: string[]): FlashEvent[] {
  const events: FlashEvent[] = [
    f.create('LayoutChanged', { layout: LISTEN_LAYOUT }, BASE),
    f.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: '한국어',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      },
      BASE + 1,
    ),
  ];
  NOTE_KEYS.forEach((key, i) => {
    events.push(
      f.create(
        'NoteUpserted',
        {
          note_id: noteIdFor(i),
          deck_id: DECK,
          source_key: key,
          fields: { word: key, meaning: `m${i}`, audio: audio[i] ?? '' },
          created_order: i,
        },
        BASE + 2 + i,
      ),
    );
  });
  return events;
}

function review(
  f: ReturnType<typeof createEventFactory>,
  id: string,
  cardId: string,
  at: number,
  rating: ReviewRating = 3,
): FlashEvent {
  return f.create(
    'ReviewRecorded',
    {
      review_id: id,
      card_id: cardId,
      rating,
      reviewed_at: at,
      tz_offset: 540,
      duration_ms: 1000,
      answer_mode: 'listen',
      fsrs_params_version: 0,
      resulting_due_at: at,
    },
    at,
  );
}

function setAudio(
  f: ReturnType<typeof createEventFactory>,
  i: number,
  value: string,
  at: number,
): FlashEvent {
  return f.create(
    'NoteUpserted',
    {
      note_id: noteIdFor(i),
      deck_id: DECK,
      source_key: NOTE_KEYS[i] ?? '',
      fields: { audio: value },
    },
    at,
  );
}

function replay(events: readonly FlashEvent[], chunk = events.length): CollectionState {
  const st = createEmptyState();
  for (let i = 0; i < events.length; i += chunk) applyEvents(st, events.slice(i, i + chunk));
  return st;
}

describe('optional cards: layout required_field', () => {
  it('treats whitespace-only fields as empty', () => {
    expect(isFieldFilled(undefined)).toBe(false);
    expect(isFieldFilled('  \n')).toBe(false);
    expect(isFieldFilled('a')).toBe(true);
    const recog = BUILTIN_LAYOUTS.find((l) => l.id === RECOG);
    expect(recog?.required_field).toBeUndefined();
    const note = {
      id: 'n',
      deck_id: DECK,
      fields: {},
      tags: [],
      source_key: 'k',
      provenance: { source: 'user' as const, reviewed: true },
      archived: false,
      created_order: 0,
    };
    const koType = BUILTIN_NOTE_TYPES.find((n) => n.id === BUILTIN_NOTE_TYPE_IDS.VOCAB_KO);
    expect(layoutRuleMet(note, recog as Layout, koType)).toBe(true);
    expect(layoutRuleMet(note, LISTEN_LAYOUT, koType)).toBe(false);
    // A rule on a field the note type lacks, or on a cloze layout's text, is ignored.
    expect(layoutRuleMet(note, { ...LISTEN_LAYOUT, required_field: 'nope' }, koType)).toBe(true);
    expect(requiredFieldProblem({ ...LISTEN_LAYOUT, required_field: 'nope' }, koType)).toBe(
      'unknown_field',
    );
    const cloze = BUILTIN_LAYOUTS.find((l) => l.answer_mode === 'cloze') as Layout;
    const clozeType = BUILTIN_NOTE_TYPES.find((n) => n.id === cloze.note_type_id);
    expect(requiredFieldProblem({ ...cloze, required_field: 'text' }, clozeType)).toBe(
      'cloze_text',
    );
    expect(requiredFieldProblem({ ...cloze, required_field: 'audio' }, clozeType)).toBeUndefined();
  });

  it('makes the card only for notes whose required field is filled', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const st = replay(setupEvents(f, ['sound:a.mp3', '', '   ']));
    expect(st.cards.has(listenCardFor(0))).toBe(true);
    expect(st.cards.has(listenCardFor(1))).toBe(false);
    expect(st.cards.has(listenCardFor(2))).toBe(false);
    // The rule only touches its own layout.
    for (let i = 0; i < 3; i++) expect(st.cards.has(recogCardFor(i))).toBe(true);
    // Filling the field later makes the card.
    applyEvents(st, [setAudio(f, 1, 'sound:b.mp3', BASE + 100)]);
    expect(st.cards.has(listenCardFor(1))).toBe(true);
    expect(st.cards.get(listenCardFor(1))?.empty).toBeUndefined();
  });

  it('keeps a studied card with its history as empty, hidden from Study, and restores it', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const events = setupEvents(f, ['sound:a.mp3', 'sound:b.mp3', '']);
    events.push(review(f, 'r1', listenCardFor(0), BASE + 1_000));
    events.push(review(f, 'r2', listenCardFor(0), BASE + 90_000_000));
    const st = replay(events);
    const before = st.cards.get(listenCardFor(0));
    expect(before?.schedule.reps).toBe(2);

    // Emptying the field: card 0 has history so it stays as `empty`; card 1 had none so it goes.
    applyEvents(st, [
      setAudio(f, 0, '', BASE + 100_000_000),
      setAudio(f, 1, ' ', BASE + 100_000_001),
    ]);
    const emptied = st.cards.get(listenCardFor(0));
    expect(emptied?.empty).toBe(true);
    expect(emptied?.schedule).toEqual(before?.schedule);
    expect(st.cards.has(listenCardFor(1))).toBe(false);
    expect(st.reviewsByCard.get(listenCardFor(0))).toHaveLength(2);

    const ctx = { nowMs: BASE + 400 * 86_400_000, tzOffsetMinutes: 540 };
    const queue = buildStudyQueue(st, { ...ctx, deckId: DECK }).queue.map((c) => c.id);
    expect(queue).not.toContain(listenCardFor(0));
    expect(filterCards(st, { states: ['empty'] }, ctx).map((c) => c.id)).toEqual([
      listenCardFor(0),
    ]);
    expect(
      filterCards(st, { deckIds: [DECK] }, { ...ctx, excludeSuspended: true }).map((c) => c.id),
    ).not.toContain(listenCardFor(0));

    // Refilling brings it back as a normal card with the same history.
    applyEvents(st, [setAudio(f, 0, 'sound:a2.mp3', BASE + 200_000_000)]);
    const back = st.cards.get(listenCardFor(0));
    expect(back?.empty).toBeUndefined();
    expect(back?.schedule).toEqual(before?.schedule);
    expect(buildStudyQueue(st, { ...ctx, deckId: DECK }).queue.map((c) => c.id)).toContain(
      listenCardFor(0),
    );
  });

  it('drops an empty card once its only review is undone', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const events = setupEvents(f, ['sound:a.mp3', '', '']);
    events.push(review(f, 'r1', listenCardFor(0), BASE + 1_000));
    events.push(setAudio(f, 0, '', BASE + 2_000));
    const st = replay(events);
    expect(st.cards.get(listenCardFor(0))?.empty).toBe(true);
    const res = applyEvents(st, [f.create('ReviewUndone', { review_id: 'r1' }, BASE + 3_000)]);
    expect(res.cards.has(listenCardFor(0))).toBe(false);
  });

  it('brings a card back as empty when its review syncs in after the field was emptied', () => {
    const a = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const b = createEventFactory('dev-b', 0, createHlcState('dev-b', BASE));
    const setup = setupEvents(a, ['sound:a.mp3', '', '']);
    const late = review(b, 'rb', listenCardFor(0), BASE + 1_000);
    const emptyIt = setAudio(a, 0, '', BASE + 2_000);
    const st = replay([...setup, emptyIt]);
    expect(st.cards.has(listenCardFor(0))).toBe(false);
    const hydrated = deserializeCollectionState(
      JSON.parse(JSON.stringify(serializeCollectionState(st))) as ReturnType<
        typeof serializeCollectionState
      >,
    );
    for (const target of [st, hydrated]) {
      applyEvents(target, [late]);
      expect(target.cards.get(listenCardFor(0))?.empty).toBe(true);
      expect(target.cards.get(listenCardFor(0))?.schedule.reps).toBe(1);
    }
    expect(replay([...setup, emptyIt, late]).cards.get(listenCardFor(0))).toEqual(
      st.cards.get(listenCardFor(0)),
    );
  });

  it("ignores a rule on an unknown field and on a cloze layout's text", () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const events = setupEvents(f, ['', '', '']);
    events.push(
      f.create(
        'LayoutChanged',
        { layout: { ...LISTEN_LAYOUT, required_field: 'nope' } },
        BASE + 50,
      ),
    );
    const st = replay(events);
    for (let i = 0; i < 3; i++) expect(st.cards.get(listenCardFor(i))?.empty).toBeUndefined();

    // Cloze: c1/c2 cards stay when the rule names the cloze text and the text is emptied.
    const cloze = BUILTIN_LAYOUTS.find((l) => l.answer_mode === 'cloze') as Layout;
    const g = createEventFactory('dev-b', 0, createHlcState('dev-b', BASE));
    const noteId = deriveNoteId('deck-cloze', 'k');
    const clozeEvents: FlashEvent[] = [
      g.create('LayoutChanged', { layout: { ...cloze, required_field: 'text' } }, BASE),
      g.create(
        'DeckCreated',
        { deck_id: 'deck-cloze', name: 'c', note_type_id: cloze.note_type_id, language: 'ja' },
        BASE + 1,
      ),
      g.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: 'deck-cloze',
          source_key: 'k',
          fields: { text: '{{c1::a}} {{c2::b}}' },
        },
        BASE + 2,
      ),
    ];
    const c2 = deriveCardId(noteId, cloze.id, 2);
    expect(replay(clozeEvents).cards.has(c2)).toBe(true);
  });

  it('gives an empty card only the Empty state, never Learning, Review or Due', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const events = setupEvents(f, ['sound:a.mp3', '', '']);
    events.push(review(f, 'r1', listenCardFor(0), BASE + 1_000, 1));
    events.push(setAudio(f, 0, '', BASE + 2_000));
    const st = replay(events);
    const card = st.cards.get(listenCardFor(0));
    expect(card?.empty).toBe(true);
    const ctx = { nowMs: BASE + 3_000, tzOffsetMinutes: 540 };
    expect(getCardStateKinds(st, card as Card, ctx)).toEqual(new Set(['empty']));
    for (const state of ['learning', 'review', 'due', 'new'] as const) {
      expect(filterCards(st, { states: [state] }, ctx).map((c) => c.id)).not.toContain(
        listenCardFor(0),
      );
    }
  });

  it('hydrating a snapshot saved by a build without optional cards equals a full replay', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const events = setupEvents(f, ['sound:a.mp3', '', 'sound:c.mp3']);
    events.push(review(f, 'r1', listenCardFor(0), BASE + 1_000));
    events.push(review(f, 'r2', listenCardFor(2), BASE + 1_000));
    events.push(setAudio(f, 0, '', BASE + 2_000));
    const reference = replay(events);

    // An older build ignores `required_field` (every note gets the card, none is `empty`) but
    // keeps it on the layout, which its snapshot serializes with a spread.
    const old = replay(
      events.map((e) =>
        e.type === 'LayoutChanged'
          ? { ...e, payload: { layout: { ...LISTEN_LAYOUT, required_field: undefined } } }
          : e,
      ),
    );
    for (let i = 0; i < 3; i++) expect(old.cards.get(listenCardFor(i))?.empty).toBeUndefined();
    const serialized = JSON.parse(JSON.stringify(serializeCollectionState(old))) as ReturnType<
      typeof serializeCollectionState
    >;
    serialized.layouts = serialized.layouts.map((l) => (l.id === LISTEN ? LISTEN_LAYOUT : l));
    const hydrated = deserializeCollectionState(serialized);

    const cardsOf = (st: CollectionState) =>
      [...st.cards.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(cardsOf(hydrated)).toEqual(cardsOf(reference));
    expect(hydrated.cards.has(listenCardFor(1))).toBe(false);
    expect(hydrated.cards.get(listenCardFor(0))?.empty).toBe(true);
    expect([...(hydrated.cardIdsByNote.get(noteIdFor(1)) ?? [])].sort()).toEqual(
      [...(reference.cardIdsByNote.get(noteIdFor(1)) ?? [])].sort(),
    );
  });

  it('round-trips a rule through .flashpkg and drops one on an unknown field with a warning', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const bad: Layout = {
      ...LISTEN_LAYOUT,
      id: `${LISTEN}:bad`,
      name: 'Bad',
      required_field: 'nope',
    };
    const st = replay([
      ...setupEvents(f, ['sound:a.mp3', '', '']),
      f.create('LayoutChanged', { layout: bad }, BASE + 20),
    ]);
    const pkg = exportFlashpkg(st, { packageId: 'pkg:opt', name: 'Opt', version: '1.0.0' });
    const g = createEventFactory('dev-b', 0, createHlcState('dev-b', BASE + 100));
    const res = importFlashpkg(pkg, createEmptyState(), g, { nowMs: BASE + 100 });
    const layouts = res.events.flatMap((e) =>
      e.type === 'LayoutChanged' ? [e.payload.layout] : [],
    );
    expect(layouts.find((l) => l.id === LISTEN)?.required_field).toBe('audio');
    expect(layouts.find((l) => l.id === bad.id)).toBeDefined();
    expect(layouts.find((l) => l.id === bad.id)?.required_field).toBeUndefined();
    expect(res.warnings.map((w) => w.code)).toContain('layout_required_field_dropped');
  });
});
