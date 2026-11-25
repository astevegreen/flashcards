import { default_w } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { createEventFactory, replayAllEvents } from '../src/events/replay.ts';
import type { FlashEvent, ReviewRecordedPayload } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';

const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);

function setup() {
  const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
  const base: FlashEvent[] = [
    f.create(
      'DeckCreated',
      {
        deck_id: 'd1',
        name: 'Korean',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      },
      t0,
    ),
    f.create(
      'NoteUpserted',
      {
        note_id: deriveNoteId('d1', 'k1'),
        deck_id: 'd1',
        source_key: 'k1',
        fields: { word: '학교', meaning: 'school' },
      },
      t0 + 1,
    ),
  ];
  const cardId = [...replayAllEvents(base).cards.keys()][0] ?? '';
  let n = 0;
  const review = (patch: Record<string, unknown> = {}): FlashEvent => {
    n += 1;
    const at = t0 + n * 60_000;
    const payload: ReviewRecordedPayload = {
      review_id: `r${n}`,
      card_id: cardId,
      rating: 3,
      reviewed_at: at,
      tz_offset: 0,
      duration_ms: 1000,
      answer_mode: 'flip',
      fsrs_params_version: 0,
      resulting_due_at: at,
    };
    return f.create('ReviewRecorded', { ...payload, ...patch } as ReviewRecordedPayload, at);
  };
  /** An envelope from the factory carrying a payload (or type) no build writes. */
  const forged = (type: string, payload: unknown): FlashEvent => ({
    ...f.create('PreferencesChanged', { preferences: {} }, t0 + 2),
    type,
    payload,
  });
  return { f, base, cardId, review, forged };
}

describe('replay payload validation (D4)', () => {
  it('keeps malformed and newer-schema events in unknownEvents and still loads the collection', () => {
    const { f, base, cardId, review, forged } = setup();
    const bad: FlashEvent[] = [
      review({ rating: 7 }),
      review({ rating: '3' }),
      review({ reviewed_at: Number.NaN }),
      review({ reviewed_at: '2026-11-25' }),
      f.create(
        'DeckFSRSParamsChanged',
        {
          deck_id: 'd1',
          params_version: 1,
          effective_from: t0,
          params: { request_retention: 1.5 },
        },
        t0 + 3,
      ),
      f.create(
        'DeckFSRSParamsChanged',
        {
          deck_id: 'd1',
          params_version: 2,
          effective_from: t0,
          params: { request_retention: 0.9, w: [1, 2, 3] },
        },
        t0 + 4,
      ),
      f.create('DeckSettingsChanged', { deck_id: 'd1', settings: { target_retention: 5 } }, t0 + 5),
      forged('NoteUpserted', { note_id: 'n2', deck_id: 'd1', source_key: 'k2' }),
      forged('NoteUpserted', { note_id: 'n3', deck_id: 'd1', source_key: 'k3', fields: { a: 1 } }),
      forged('NoteTypeChanged', {}),
      forged('LayoutChanged', { layout: { id: 'l1', front_fields: 'word' } }),
      forged('MediaAdded', { media: { hash: 42 } }),
      forged('PreferencesChanged', null),
      { ...review(), v: 2 },
    ];
    const good = review();

    const state = replayAllEvents([...base, ...bad, good]);

    expect(state.unknownEvents.map((e) => e.id)).toEqual(bad.map((e) => e.id));
    const card = state.cards.get(cardId);
    expect(card?.schedule.reps).toBe(1);
    expect(Number.isFinite(card?.schedule.due)).toBe(true);
    expect(state.deckFsrsParams.get('d1')).toBeUndefined();
    expect(state.decks.get('d1')?.settings.target_retention).toBe(0.9);
    expect(state.notes.has('n2')).toBe(false);
    expect(state.notes.has('n3')).toBe(false);
  });

  it('applies valid FSRS params, including an optimized 21-weight set', () => {
    const { f, base, review } = setup();
    const w = [...default_w];
    const params = f.create(
      'DeckFSRSParamsChanged',
      {
        deck_id: 'd1',
        params_version: 1,
        effective_from: t0,
        params: { request_retention: 0.85, w },
      },
      t0 + 3,
    );
    const state = replayAllEvents([...base, params, review()]);
    expect(state.unknownEvents).toEqual([]);
    expect(state.deckFsrsParams.get('d1')?.[0]?.params.request_retention).toBe(0.85);
  });
});
