import fc from 'fast-check';
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
import { isFieldFilled, layoutRuleMet } from '../src/model/optional-cards.ts';
import { BUILTIN_LAYOUTS, BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import type { Layout, ReviewRating } from '../src/model/types.ts';
import { filterCards } from '../src/study/filter.ts';
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
    expect(layoutRuleMet(note, recog as Layout)).toBe(true);
    expect(layoutRuleMet(note, LISTEN_LAYOUT)).toBe(false);
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

  it('converges under any order, chunking and snapshot hydration (fast-check)', () => {
    const actionArb = fc.oneof(
      fc.record({
        kind: fc.constant('review' as const),
        device: fc.integer({ min: 0, max: 1 }),
        card: fc.integer({ min: 0, max: 2 }),
        rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4),
        dt: fc.integer({ min: 1, max: 400_000 }),
      }),
      fc.record({
        kind: fc.constant('audio' as const),
        device: fc.integer({ min: 0, max: 1 }),
        card: fc.integer({ min: 0, max: 2 }),
        value: fc.constantFrom('', ' ', 'sound:x.mp3', 'sound:y.mp3'),
        dt: fc.integer({ min: 1, max: 50_000 }),
      }),
      fc.record({
        kind: fc.constant('undo' as const),
        device: fc.integer({ min: 0, max: 1 }),
        pick: fc.integer({ min: 0, max: 50 }),
        dt: fc.integer({ min: 1, max: 5_000 }),
      }),
    );
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 2, maxLength: 30 }),
        fc.integer({ min: 1, max: 100_000 }),
        (actions, seed) => {
          const factories = [
            createEventFactory('dev-a', 0, createHlcState('dev-a', BASE)),
            createEventFactory('dev-b', 0, createHlcState('dev-b', BASE + 500)),
          ] as const;
          const [f0] = factories;
          const events = setupEvents(f0, ['sound:a.mp3', '', 'sound:c.mp3']);
          let clock = BASE + 1_000;
          const reviewIds: string[] = [];
          for (const act of actions) {
            clock += act.dt;
            const f = factories[act.device] ?? f0;
            if (act.kind === 'review') {
              const id = `r-${reviewIds.length}`;
              reviewIds.push(id);
              events.push(review(f, id, listenCardFor(act.card), clock, act.rating));
            } else if (act.kind === 'audio') {
              events.push(setAudio(f, act.card, act.value, clock));
            } else if (reviewIds.length > 0) {
              const id = reviewIds[act.pick % reviewIds.length] ?? '';
              events.push(f.create('ReviewUndone', { review_id: id }, clock));
            }
          }
          const observe = (st: CollectionState) =>
            [0, 1, 2].map((i) => st.cards.get(listenCardFor(i)) ?? null);
          const reference = observe(replay(events));
          let x = seed;
          const shuffled = [...events].sort(() => {
            x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
            return (x & 1) === 0 ? -1 : 1;
          });
          expect(observe(replay([...events].reverse(), 1))).toEqual(reference);
          expect(observe(replay(shuffled, 3))).toEqual(reference);
          const cut = Math.floor(shuffled.length / 2);
          const hydrated = deserializeCollectionState(
            JSON.parse(
              JSON.stringify(serializeCollectionState(replay(shuffled.slice(0, cut), 2))),
            ) as ReturnType<typeof serializeCollectionState>,
          );
          applyEvents(hydrated, shuffled.slice(cut));
          expect(observe(hydrated)).toEqual(reference);
        },
      ),
      { numRuns: 150 },
    );
  });
});
