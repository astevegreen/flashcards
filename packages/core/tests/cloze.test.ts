import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  buildStudyQueue,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveCardId,
  deriveNoteId,
  extractClozeAnswersForVariant,
  extractClozeNumbers,
  parseCloze,
  replayAllEvents,
  stripCloze,
  BUILTIN_NOTE_TYPE_IDS,
  type FlashEvent,
} from '../src/index.ts';

describe('Cloze parser golden tests (§5.2)', () => {
  it('parses simple cloze and cloze with hint', () => {
    expect(parseCloze('I {{c1::eat}} apples.')).toEqual([
      { type: 'text', value: 'I ' },
      { type: 'cloze', index: 1, answer: 'eat' },
      { type: 'text', value: ' apples.' },
    ]);

    expect(parseCloze('私{{c1::は::topic}}学生です。')).toEqual([
      { type: 'text', value: '私' },
      { type: 'cloze', index: 1, answer: 'は', hint: 'topic' },
      { type: 'text', value: '学生です。' },
    ]);
  });

  it('safely handles nested ruby single braces and bracket furigana inside cloze', () => {
    expect(
      parseCloze('{{c1::{今日|きょう}::today}}は{{c2::学生[がくせい]::student}}です。'),
    ).toEqual([
      { type: 'cloze', index: 1, answer: '{今日|きょう}', hint: 'today' },
      { type: 'text', value: 'は' },
      { type: 'cloze', index: 2, answer: '学生[がくせい]', hint: 'student' },
      { type: 'text', value: 'です。' },
    ]);
    expect(extractClozeNumbers('{{c1::{今日|きょう}}}と{{c2::学生[がくせい]}}')).toEqual([1, 2]);
    expect(stripCloze('{{c1::{今日|きょう}::today}}は晴れ')).toBe('{今日|きょう}は晴れ');
  });

  it('handles repeated same-number blanks and ascending unique variant extraction', () => {
    const text = 'りんご{{c2::も::also}}バナナ{{c2::も}}、そして{{c1::水}}。';
    expect(extractClozeNumbers(text)).toEqual([1, 2]);
    expect(extractClozeAnswersForVariant(text, 2)).toEqual(['も', 'も']);
    expect(extractClozeAnswersForVariant(text, 1)).toEqual(['水']);
    expect(stripCloze(text)).toBe('りんごもバナナも、そして水。');
  });

  it('preserves malformed, empty, or unclosed tags verbatim as plain text', () => {
    expect(parseCloze('broken {{c1::unclosed text')).toEqual([
      { type: 'text', value: 'broken {{c1::unclosed text' },
    ]);
    expect(parseCloze('zero {{c0::nope}} and empty {{c1::}}')).toEqual([
      { type: 'text', value: 'zero {{c0::nope}} and empty {{c1::}}' },
    ]);
    expect(extractClozeNumbers('plain text without cloze')).toEqual([]);
  });

  it('closes a cloze whose body has an unmatched { at the first }} as Anki does (C19)', () => {
    expect(parseCloze('{{c1::{a}}')).toEqual([{ type: 'cloze', index: 1, answer: '{a' }]);
    expect(parseCloze('x {{c2::a{b::hint}} y')).toEqual([
      { type: 'text', value: 'x ' },
      { type: 'cloze', index: 2, answer: 'a{b', hint: 'hint' },
      { type: 'text', value: ' y' },
    ]);
    // Balanced ruby braces still close at the outer `}}`; no `}}` at all stays text.
    expect(parseCloze('{{c1::{今日|きょう}}}')).toEqual([
      { type: 'cloze', index: 1, answer: '{今日|きょう}' },
    ]);
    expect(parseCloze('{{c1::{a}')).toEqual([{ type: 'text', value: '{{c1::{a}' }]);
  });

  it('stays linear on pathological input (a hostile deck must not freeze replay)', () => {
    const inputs = [
      '{{c1::'.repeat(170_000),
      '{{c1::{'.repeat(150_000),
      '{{c1::{a}'.repeat(110_000) + '}}',
      '{'.repeat(1_000_000),
    ];
    const start = Date.now();
    for (const input of inputs) parseCloze(input);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe('Multi-variant Cloze card derivation, sibling burying & convergence', () => {
  it('derives distinct cards per cloze number, preserves c1 history on edit, and buries siblings', () => {
    const t0 = Date.UTC(2026, 4, 1, 10, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const deckId = 'deck-cloze-1';
    const noteId = deriveNoteId(deckId, 'n1');
    const layoutId = 'layout:cloze:recognition';

    const evs: FlashEvent[] = [
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Cloze Test',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.CLOZE,
          language: 'ja',
          created_at: t0,
        },
        t0,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: deckId,
          source_key: 'n1',
          fields: {
            text: '私{{c1::は::topic}}東京{{c2::に::dest}}行きます。',
            meaning: 'I go to Tokyo.',
          },
          tags: ['particles'],
          created_order: 0,
        },
        t0 + 1,
      ),
    ];

    const state = replayAllEvents(evs);
    const c1Id = deriveCardId(noteId, layoutId, 1);
    const c2Id = deriveCardId(noteId, layoutId, 2);

    expect(state.cards.size).toBe(2);
    expect(state.cards.get(c1Id)?.variant).toBe(1);
    expect(state.cards.get(c2Id)?.variant).toBe(2);

    // Queue today should show c1 first and bury sibling c2
    const q1 = buildStudyQueue(state, { deckId, nowMs: t0 + 1000, tzOffsetMinutes: 0 });
    expect(q1.queue).toHaveLength(1);
    expect(q1.queue[0]?.id).toBe(c1Id);
    expect(q1.buriedNoteIds.has(noteId)).toBe(true);

    // Review c1 Easy (graduates out of intraday learning) -> c2 remains buried today, appears tomorrow!
    const reviewEv = factory.create(
      'ReviewRecorded',
      {
        review_id: 'rev-c1-1',
        card_id: c1Id,
        rating: 4,
        reviewed_at: t0 + 2000,
        tz_offset: 0,
        duration_ms: 1500,
        answer_mode: 'cloze',
        fsrs_params_version: 0,
        resulting_due_at: t0 + 4 * 86_400_000,
      },
      t0 + 2000,
    );
    applyEvents(state, [reviewEv]);

    const qSameDay = buildStudyQueue(state, { deckId, nowMs: t0 + 3000, tzOffsetMinutes: 0 });
    expect(qSameDay.queue).toHaveLength(0);
    expect(qSameDay.buriedNoteIds.has(noteId)).toBe(true);

    const qNextDay = buildStudyQueue(state, {
      deckId,
      nowMs: t0 + 24 * 3_600_000 + 3000,
      tzOffsetMinutes: 0,
    });
    expect(qNextDay.queue.some((c) => c.id === c2Id)).toBe(true);

    // Edit note to remove c2 and add c3 -> c2 card removed, c3 added, c1 review history preserved!
    const editEv = factory.create(
      'NoteUpserted',
      {
        note_id: noteId,
        deck_id: deckId,
        source_key: 'n1',
        fields: {
          text: '私{{c1::は}}東京へ{{c3::行きます}}。',
        },
      },
      t0 + 4000,
    );
    applyEvents(state, [editEv]);

    const c3Id = deriveCardId(noteId, layoutId, 3);
    expect(state.cards.has(c1Id)).toBe(true);
    expect(state.cards.get(c1Id)?.schedule.reps).toBe(1);
    expect(state.cards.has(c2Id)).toBe(false);
    expect(state.cards.get(c3Id)?.variant).toBe(3);
  });

  it('converges identically across arbitrary permutations of cloze edits & reviews (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            device: fc.constantFrom('dev-a', 'dev-b'),
            kind: fc.constantFrom('edit', 'review_c1', 'review_c2'),
            textVariant: fc.constantFrom(
              'A {{c1::one}} B {{c2::two}}',
              'A {{c1::uno}} B {{c2::dos}} C {{c3::tres}}',
              'A {{c1::ichi}} B plain',
            ),
            rating: fc.constantFrom(1 as const, 3 as const, 4 as const),
          }),
          { minLength: 3, maxLength: 14 },
        ),
        fc.integer({ min: 1, max: 1000 }),
        (ops, seed) => {
          const baseMs = Date.UTC(2026, 3, 1, 9, 0, 0);
          const fA = createEventFactory('dev-a', 0, createHlcState('dev-a', baseMs));
          const fB = createEventFactory('dev-b', 0, createHlcState('dev-b', baseMs));
          const deckId = 'deck-prop-cloze';
          const noteId = deriveNoteId(deckId, 'n-prop');
          const layoutId = 'layout:cloze:recognition';

          const allEvents: FlashEvent[] = [
            fA.create(
              'DeckCreated',
              {
                deck_id: deckId,
                name: 'Prop Cloze',
                note_type_id: BUILTIN_NOTE_TYPE_IDS.CLOZE,
                language: 'en',
                created_at: baseMs,
              },
              baseMs,
            ),
            fA.create(
              'NoteUpserted',
              {
                note_id: noteId,
                deck_id: deckId,
                source_key: 'n-prop',
                fields: { text: 'A {{c1::one}} B {{c2::two}}' },
                tags: [],
                created_order: 0,
              },
              baseMs + 10,
            ),
          ];

          ops.forEach((op, idx) => {
            const f = op.device === 'dev-a' ? fA : fB;
            const ts = baseMs + (idx + 2) * 10_000;
            if (op.kind === 'edit') {
              allEvents.push(
                f.create(
                  'NoteUpserted',
                  {
                    note_id: noteId,
                    deck_id: deckId,
                    source_key: 'n-prop',
                    fields: { text: op.textVariant },
                  },
                  ts,
                ),
              );
            } else {
              const variant = op.kind === 'review_c1' ? 1 : 2;
              allEvents.push(
                f.create(
                  'ReviewRecorded',
                  {
                    review_id: `rev-${idx}-${op.device}`,
                    card_id: deriveCardId(noteId, layoutId, variant),
                    rating: op.rating,
                    reviewed_at: ts,
                    tz_offset: 0,
                    duration_ms: 800,
                    answer_mode: 'cloze',
                    fsrs_params_version: 0,
                    resulting_due_at: ts + 86_400_000,
                  },
                  ts,
                ),
              );
            }
          });

          // Permute deterministically using seed
          const permuted = [...allEvents].sort((a, b) => {
            const ha = (a.id.charCodeAt(a.id.length - 1) * 31 + seed) % 97;
            const hb = (b.id.charCodeAt(b.id.length - 1) * 31 + seed) % 97;
            return ha - hb || (a.id < b.id ? -1 : 1);
          });

          const stateForward = applyEvents(createEmptyState(), allEvents);
          const statePermuted = applyEvents(createEmptyState(), permuted);

          const snap = (s: typeof stateForward) =>
            [...s.cards.values()]
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((c) => ({ id: c.id, variant: c.variant, schedule: c.schedule }));

          expect(snap(statePermuted)).toEqual(snap(stateForward));
        },
      ),
      { numRuns: 30 },
    );
  });
});
