import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import type { Layout, ReviewRating } from '../src/model/types.ts';

const DECKS = ['deck-opt-a', 'deck-opt-b'] as const;
const RECOG = 'layout:vocab-ko:recognition';
const LISTEN = 'layout:custom:preset:vocab-ko:listen:prop';
const LAYOUTS = [RECOG, LISTEN] as const;
/** Two notes per deck: note i lives in DECKS[i % 2]. */
const NOTES = [0, 1, 2, 3].map((i) => {
  const deckId = DECKS[i % 2] ?? DECKS[0];
  const key = `k${i}`;
  return { deckId, key, id: deriveNoteId(deckId, key) };
});
const cardOf = (note: number, layout: number) =>
  deriveCardId(NOTES[note]?.id ?? '', LAYOUTS[layout] ?? RECOG, 0);

const LISTEN_LAYOUT: Layout = {
  id: LISTEN,
  note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
  name: 'Listen',
  front_fields: ['audio'],
  reveal_steps: [['word', 'meaning']],
  answer_mode: 'listen',
  hide_furigana_on_front: false,
  enabled: true,
};

const BASE = Date.UTC(2026, 10, 2, 1, 0, 0);

function replayChunked(list: readonly FlashEvent[], chunk: number): CollectionState {
  const st = createEmptyState();
  for (let i = 0; i < list.length; i += chunk) applyEvents(st, list.slice(i, i + chunk));
  return st;
}

function shuffleWithSeed<T>(arr: readonly T[], seed: number): T[] {
  const copy = [...arr];
  let x = seed || 1;
  for (let i = copy.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

/** Every card, by id: existence, `empty`, deck and the replayed schedule. */
function observe(st: CollectionState) {
  return [...st.cards.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => ({ id: c.id, deck: c.deck_id, empty: c.empty ?? false, schedule: c.schedule }));
}

const deviceArb = fc.integer({ min: 0, max: 1 });
const noteArb = fc.integer({ min: 0, max: 3 });
const actionArb = fc.oneof(
  fc.record({
    kind: fc.constant('review' as const),
    device: deviceArb,
    note: noteArb,
    layout: fc.integer({ min: 0, max: 1 }),
    rating: fc.constantFrom<ReviewRating>(1, 3, 4),
    dt: fc.integer({ min: 1, max: 400_000 }),
  }),
  fc.record({
    kind: fc.constant('field' as const),
    device: deviceArb,
    note: noteArb,
    field: fc.constantFrom('audio', 'meaning'),
    value: fc.constantFrom('', ' ', 'x', 'y'),
    dt: fc.integer({ min: 1, max: 50_000 }),
  }),
  fc.record({
    kind: fc.constant('rule' as const),
    device: deviceArb,
    layout: fc.integer({ min: 0, max: 1 }),
    field: fc.constantFrom(undefined, 'audio', 'meaning', 'not-a-field'),
    // Rule edits on two devices often land within the same few ms (concurrent).
    dt: fc.integer({ min: 0, max: 3 }),
  }),
  fc.record({
    kind: fc.constant('enabled' as const),
    device: deviceArb,
    deck: fc.integer({ min: 0, max: 1 }),
    ids: fc.subarray([RECOG, LISTEN]),
    dt: fc.integer({ min: 1, max: 20_000 }),
  }),
  fc.record({
    kind: fc.constant('noteArchive' as const),
    device: deviceArb,
    note: noteArb,
    archived: fc.boolean(),
    dt: fc.integer({ min: 1, max: 20_000 }),
  }),
  fc.record({
    kind: fc.constant('deckArchive' as const),
    device: deviceArb,
    deck: fc.integer({ min: 0, max: 1 }),
    archived: fc.boolean(),
    dt: fc.integer({ min: 1, max: 20_000 }),
  }),
  fc.record({
    kind: fc.constant('undo' as const),
    device: deviceArb,
    pick: fc.integer({ min: 0, max: 60 }),
    dt: fc.integer({ min: 1, max: 5_000 }),
  }),
);

function buildEvents(
  factories: readonly [EventFactory, EventFactory],
  actions: readonly (typeof actionArb extends fc.Arbitrary<infer A> ? A : never)[],
): FlashEvent[] {
  const [f0] = factories;
  const events: FlashEvent[] = [
    f0.create('LayoutChanged', { layout: { ...LISTEN_LAYOUT, required_field: 'audio' } }, BASE),
  ];
  DECKS.forEach((deckId, i) => {
    events.push(
      f0.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: `deck ${i}`,
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
        },
        BASE + 1 + i,
      ),
    );
  });
  NOTES.forEach((n, i) => {
    events.push(
      f0.create(
        'NoteUpserted',
        {
          note_id: n.id,
          deck_id: n.deckId,
          source_key: n.key,
          fields: { word: n.key, meaning: `m${i}`, audio: i % 2 === 0 ? 'a.mp3' : '' },
          created_order: i,
        },
        BASE + 10 + i,
      ),
    );
  });

  let clock = BASE + 1_000;
  const reviewIds: string[] = [];
  for (const act of actions) {
    clock += act.dt;
    const f = factories[act.device] ?? f0;
    switch (act.kind) {
      case 'review': {
        const id = `r-${reviewIds.length}`;
        reviewIds.push(id);
        events.push(
          f.create(
            'ReviewRecorded',
            {
              review_id: id,
              card_id: cardOf(act.note, act.layout),
              rating: act.rating,
              reviewed_at: clock,
              tz_offset: 540,
              duration_ms: 1000,
              answer_mode: 'flip',
              fsrs_params_version: 0,
              resulting_due_at: clock,
            },
            clock,
          ),
        );
        break;
      }
      case 'field': {
        const n = NOTES[act.note] ?? NOTES[0];
        if (!n) break;
        events.push(
          f.create(
            'NoteUpserted',
            {
              note_id: n.id,
              deck_id: n.deckId,
              source_key: n.key,
              fields: { [act.field]: act.value },
            },
            clock,
          ),
        );
        break;
      }
      case 'rule': {
        const base: Layout =
          act.layout === 0
            ? {
                id: RECOG,
                note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
                name: 'Recognition',
                front_fields: ['word'],
                reveal_steps: [['hanja', 'meaning']],
                answer_mode: 'flip',
                hide_furigana_on_front: false,
                enabled: true,
              }
            : LISTEN_LAYOUT;
        const layout: Layout =
          act.field === undefined ? base : { ...base, required_field: act.field };
        events.push(f.create('LayoutChanged', { layout }, clock));
        break;
      }
      case 'enabled':
        events.push(
          f.create(
            'DeckSettingsChanged',
            { deck_id: DECKS[act.deck] ?? DECKS[0], settings: { enabled_layout_ids: act.ids } },
            clock,
          ),
        );
        break;
      case 'noteArchive': {
        const id = NOTES[act.note]?.id ?? '';
        events.push(
          act.archived
            ? f.create('NoteArchived', { note_id: id }, clock)
            : f.create('NoteRestored', { note_id: id }, clock),
        );
        break;
      }
      case 'deckArchive':
        events.push(
          f.create(
            'DeckSettingsChanged',
            { deck_id: DECKS[act.deck] ?? DECKS[0], archived: act.archived },
            clock,
          ),
        );
        break;
      case 'undo':
        if (reviewIds.length > 0) {
          const id = reviewIds[act.pick % reviewIds.length] ?? '';
          events.push(f.create('ReviewUndone', { review_id: id }, clock));
        }
        break;
    }
  }
  return events;
}

describe('optional cards convergence (fast-check)', () => {
  it('converges with rule, layout, archive and review edits on two devices', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 3, maxLength: 40 }),
        fc.integer({ min: 1, max: 100_000 }),
        (actions, seed) => {
          const factories = [
            createEventFactory('dev-a', 0, createHlcState('dev-a', BASE)),
            createEventFactory('dev-b', 0, createHlcState('dev-b', BASE + 2)),
          ] as const;
          const events = buildEvents(factories, actions);
          const reference = observe(replayChunked(events, events.length));

          const orders: [FlashEvent[], number][] = [
            [[...events].reverse(), 1],
            [shuffleWithSeed(events, seed), 3],
            [[...shuffleWithSeed(events, seed + 1), ...shuffleWithSeed(events, seed + 2)], 5],
          ];
          for (const [order, chunk] of orders) {
            expect(observe(replayChunked(order, chunk))).toEqual(reference);
          }

          const shuffled = shuffleWithSeed(events, seed + 3);
          const cut = Math.floor(shuffled.length / 2);
          const hydrated = deserializeCollectionState(
            JSON.parse(
              JSON.stringify(serializeCollectionState(replayChunked(shuffled.slice(0, cut), 4))),
            ) as ReturnType<typeof serializeCollectionState>,
          );
          applyEvents(hydrated, shuffled.slice(cut));
          expect(observe(hydrated)).toEqual(reference);
        },
      ),
      { numRuns: 200 },
    );
  });
});
