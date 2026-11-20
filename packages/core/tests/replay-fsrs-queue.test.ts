import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  replayAllEvents,
  resolveDeckFsrsConfig,
} from '../src/events/replay.ts';
import {
  applyReviewToSchedule,
  getStudyDayIndex,
  previewIntervals,
} from '../src/fsrs/scheduler.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId, uuidv7 } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import { buildStudyQueue } from '../src/study/queue.ts';

describe('FSRS deterministic replay, parameter versioning, and lossless undo', () => {
  it('replays reviews deterministically and supports lossless ReviewUndone', () => {
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 1_700_000_000_000));
    const deckId = 'deck-ko-1';
    const noteId = deriveNoteId(deckId, 'n1');
    const layoutId = 'layout:vocab-ko:recognition';
    const cardId = deriveCardId(noteId, layoutId, 0);

    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const t1 = Date.UTC(2026, 0, 2, 10, 0, 0);

    const createEvs = [
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Korean Test',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
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
          fields: { word: '학교', meaning: 'school' },
          tags: ['core'],
        },
        t0,
      ),
    ];

    const state = replayAllEvents(createEvs);
    const initialCard = state.cards.get(cardId);
    expect(initialCard).toBeDefined();
    if (!initialCard) throw new Error('Expected initial card');
    expect(initialCard.schedule.state).toBe(0);

    const previews = previewIntervals(initialCard.schedule, t0);
    expect(previews[3].label.length).toBeGreaterThan(0);

    const r1Id = uuidv7(t0);
    const r1Res = applyReviewToSchedule(initialCard.schedule, 3, t0);
    const rev1 = factory.create(
      'ReviewRecorded',
      {
        review_id: r1Id,
        card_id: cardId,
        rating: 3,
        reviewed_at: t0,
        tz_offset: 0,
        duration_ms: 1200,
        answer_mode: 'flip',
        fsrs_params_version: 0,
        resulting_due_at: r1Res.resulting_due_at,
      },
      t0,
    );

    applyEvents(state, [rev1]);
    const cardAfterRev1 = state.cards.get(cardId);
    if (!cardAfterRev1) throw new Error('Expected card after rev1');
    const afterRev1 = structuredClone(cardAfterRev1.schedule);
    expect(afterRev1.reps).toBe(1);

    const r2Id = uuidv7(t1);
    const r2Res = applyReviewToSchedule(afterRev1, 4, t1);
    const rev2 = factory.create(
      'ReviewRecorded',
      {
        review_id: r2Id,
        card_id: cardId,
        rating: 4,
        reviewed_at: t1,
        tz_offset: 0,
        duration_ms: 900,
        answer_mode: 'flip',
        fsrs_params_version: 0,
        resulting_due_at: r2Res.resulting_due_at,
      },
      t1,
    );
    applyEvents(state, [rev2]);
    expect(state.cards.get(cardId)?.schedule.reps).toBe(2);

    // Undo second review -> must restore exact schedule after first review
    const undo2 = factory.create('ReviewUndone', { review_id: r2Id }, t1 + 5000);
    applyEvents(state, [undo2]);
    expect(state.cards.get(cardId)?.schedule).toEqual(afterRev1);

    // Undo first review -> must restore clean New state
    const undo1 = factory.create('ReviewUndone', { review_id: r1Id }, t1 + 6000);
    applyEvents(state, [undo1]);
    expect(state.cards.get(cardId)?.schedule.reps).toBe(0);
    expect(state.cards.get(cardId)?.schedule.state).toBe(0);
  });

  it('preserves historical FSRS parameters on DeckFSRSParamsChanged unless reschedule_existing is set', () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const tChange = Date.UTC(2026, 0, 10, 10, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const deckId = 'deck-params';
    const noteId = deriveNoteId(deckId, 'n1');
    const cardId = deriveCardId(noteId, 'layout:vocab-ko:recognition', 0);

    const baseEvents = [
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Params Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          settings: { target_retention: 0.9 },
        },
        t0,
      ),
      factory.create(
        'DeckFSRSParamsChanged',
        {
          deck_id: deckId,
          params_version: 1,
          effective_from: t0,
          params: { request_retention: 0.9, enable_fuzz: false },
        },
        t0,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: deckId,
          source_key: 'n1',
          fields: { word: '한국어', meaning: 'Korean' },
        },
        t0,
      ),
      factory.create(
        'ReviewRecorded',
        {
          review_id: 'rev-1',
          card_id: cardId,
          rating: 4, // Easy -> graduates with scheduled_days > 0
          reviewed_at: t0 + 1000,
          tz_offset: 0,
          duration_ms: 1000,
          answer_mode: 'flip',
          fsrs_params_version: 1,
          resulting_due_at: t0 + 86_400_000,
        },
        t0 + 1000,
      ),
    ];

    const stateBefore = replayAllEvents(baseEvents);
    const dueBefore = stateBefore.cards.get(cardId)?.schedule.due ?? 0;
    expect(dueBefore).toBeGreaterThan(0);

    // Emit version 2 with higher retention (0.97) effective AFTER rev-1, without rescheduling
    const v2NoReschedule = factory.create(
      'DeckFSRSParamsChanged',
      {
        deck_id: deckId,
        params_version: 2,
        effective_from: tChange,
        params: { request_retention: 0.97, enable_fuzz: false },
      },
      tChange,
    );

    const stateAfterV2 = replayAllEvents([...baseEvents, v2NoReschedule]);
    // Historical due date must remain unchanged
    expect(stateAfterV2.cards.get(cardId)?.schedule.due).toBe(dueBefore);
    // Future reviews resolve version 2 (0.97)
    expect(resolveDeckFsrsConfig(stateAfterV2, deckId, tChange + 1000).request_retention).toBe(
      0.97,
    );

    // Explicitly rescheduling with higher retention shortens the interval
    const v3Reschedule = factory.create(
      'DeckFSRSParamsChanged',
      {
        deck_id: deckId,
        params_version: 3,
        effective_from: tChange + 5000,
        params: { request_retention: 0.97, enable_fuzz: false },
        reschedule_existing: true,
      },
      tChange + 5000,
    );
    const stateRescheduled = replayAllEvents([...baseEvents, v2NoReschedule, v3Reschedule]);
    expect(stateRescheduled.cards.get(cardId)?.schedule.due).toBeLessThan(dueBefore);
  });

  it('preserves version-0 historical due dates when DeckSettingsChanged + DeckFSRSParamsChanged update target_retention', () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const t1 = Date.UTC(2026, 0, 10, 10, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const deckId = 'deck-v0-drift';
    const noteId = deriveNoteId(deckId, 'n1');
    const cardId = deriveCardId(noteId, 'layout:vocab-ko:recognition', 0);

    const initialEvents = [
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Drift Guard',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          settings: { target_retention: 0.9 },
        },
        t0,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: deckId,
          source_key: 'n1',
          fields: { word: '물', meaning: 'water' },
        },
        t0,
      ),
      factory.create(
        'ReviewRecorded',
        {
          review_id: 'rev-v0',
          card_id: cardId,
          rating: 4,
          reviewed_at: t0 + 1000,
          tz_offset: 0,
          duration_ms: 500,
          answer_mode: 'flip',
          fsrs_params_version: 0,
          resulting_due_at: t0 + 86_400_000,
        },
        t0 + 1000,
      ),
    ];

    const stateBefore = replayAllEvents(initialEvents);
    const dueBefore = stateBefore.cards.get(cardId)?.schedule.due;
    expect(dueBefore).toBeGreaterThan(t0);

    // Change retention to 0.97 via DeckSettingsChanged + DeckFSRSParamsChanged (version 1)
    const updateEvents = [
      factory.create(
        'DeckSettingsChanged',
        { deck_id: deckId, settings: { target_retention: 0.97 } },
        t1,
      ),
      factory.create(
        'DeckFSRSParamsChanged',
        {
          deck_id: deckId,
          params_version: 1,
          effective_from: t1,
          params: { request_retention: 0.97, enable_fuzz: false, enable_short_term: true },
        },
        t1,
      ),
    ];

    const stateAfter = replayAllEvents([...initialEvents, ...updateEvents]);
    expect(stateAfter.cards.get(cardId)?.schedule.due).toBe(dueBefore);
    expect(resolveDeckFsrsConfig(stateAfter, deckId, t1 + 1000).request_retention).toBe(0.97);
  });

  it('converges identically when DeckSettingsChanged, SourceLinked, and PageRead arrive in earlier batches than entity creation', () => {
    const t0 = Date.UTC(2026, 2, 1, 10, 0, 0);
    const fA = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const fB = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 500));

    const deckCreated = fA.create(
      'DeckCreated',
      {
        deck_id: 'deck-ooo',
        name: 'Original Name',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        settings: { new_cards_per_day: 20 },
      },
      t0,
    );
    const deckRenamed = fB.create(
      'DeckSettingsChanged',
      {
        deck_id: 'deck-ooo',
        name: 'Renamed Deck',
        settings: { new_cards_per_day: 45 },
      },
      t0 + 1000,
    );
    const deckSource = fB.create(
      'SourceLinked',
      {
        target_kind: 'deck',
        target_id: 'deck-ooo',
        source: { kind: 'package', package_id: 'pkg:ooo', package_version: '2.0.0' },
      },
      t0 + 1200,
    );
    const pageUpserted = fA.create(
      'PageUpserted',
      {
        page_id: 'page-ooo',
        slug: 'particles',
        title: 'Particles',
        markdown: '# Particles',
      },
      t0,
    );
    const pageRead = fB.create('PageRead', { page_id: 'page-ooo', read_at: t0 + 2000 }, t0 + 2000);
    const pageSource = fB.create(
      'SourceLinked',
      {
        target_kind: 'page',
        target_id: 'page-ooo',
        source: { kind: 'google_docs', uri: 'doc-123' },
      },
      t0 + 2100,
    );

    const inOrder = replayAllEvents([
      deckCreated,
      deckRenamed,
      deckSource,
      pageUpserted,
      pageRead,
      pageSource,
    ]);

    const outOfOrder = createEmptyState();
    applyEvents(outOfOrder, [deckRenamed, deckSource, pageRead, pageSource]);
    applyEvents(outOfOrder, [deckCreated, pageUpserted]);

    expect(outOfOrder.decks.get('deck-ooo')).toEqual(inOrder.decks.get('deck-ooo'));
    expect(outOfOrder.decks.get('deck-ooo')?.name).toBe('Renamed Deck');
    expect(outOfOrder.decks.get('deck-ooo')?.settings.new_cards_per_day).toBe(45);
    expect(outOfOrder.decks.get('deck-ooo')?.source?.package_id).toBe('pkg:ooo');
    expect(outOfOrder.pages.get('page-ooo')).toEqual(inOrder.pages.get('page-ooo'));
    expect(outOfOrder.pages.get('page-ooo')?.read_at).toBe(t0 + 2000);
    expect(outOfOrder.pages.get('page-ooo')?.source?.uri).toBe('doc-123');
  });

  it('preserves unknown future event types without crashing (§4.2)', () => {
    const state = createEmptyState();
    applyEvents(state, [
      {
        id: uuidv7(1000),
        device: 'future-dev',
        seq: 1,
        hlc: '0000000003e8-0001-future-dev',
        type: 'FutureWidgetActivated',
        v: 2,
        payload: { experimental: true },
      },
    ]);
    expect(state.unknownEvents).toHaveLength(1);
    expect(state.unknownEvents[0]?.type).toBe('FutureWidgetActivated');
  });
});

describe('Study queue, 04:00 rollover, and sibling burying (§5.1)', () => {
  it('computes study day rollover cleanly around 04:00 local time', () => {
    // 03:59 UTC vs 04:00 UTC with tzOffset = 0 and dayStartHour = 4
    const beforeRollover = Date.UTC(2026, 2, 15, 3, 59, 0);
    const atRollover = Date.UTC(2026, 2, 15, 4, 0, 0);
    expect(getStudyDayIndex(atRollover, 0, 4)).toBe(getStudyDayIndex(beforeRollover, 0, 4) + 1);
  });

  it('buries sibling cards of the same note until the next study day', () => {
    const tDay1 = Date.UTC(2026, 4, 1, 10, 0, 0);
    const tDay2 = Date.UTC(2026, 4, 2, 5, 0, 0); // past 04:00 next day
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', tDay1));
    const deckId = 'deck-siblings';
    const noteId = deriveNoteId(deckId, 'n1');
    const recCardId = deriveCardId(noteId, 'layout:vocab-ko:recognition', 0);
    const prodCardId = deriveCardId(noteId, 'layout:vocab-ko:production', 0);

    const state = replayAllEvents([
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Sibling Test',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          settings: {
            enabled_layout_ids: ['layout:vocab-ko:recognition', 'layout:vocab-ko:production'],
          },
        },
        tDay1,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: deckId,
          source_key: 'n1',
          fields: { word: '약속', meaning: 'promise' },
        },
        tDay1,
      ),
    ]);

    // Both cards derived, but only 1 enters today's queue (Recognition first), sibling is buried
    expect(state.cards.size).toBe(2);
    const qBefore = buildStudyQueue(state, { deckId, nowMs: tDay1, tzOffsetMinutes: 0 });
    expect(qBefore.queue).toHaveLength(1);
    expect(qBefore.queue[0]?.id).toBe(recCardId);
    expect(qBefore.buriedNoteIds.has(noteId)).toBe(true);

    // Rate Recognition as Easy -> sibling Production stays buried for the rest of Day 1
    applyEvents(state, [
      factory.create(
        'ReviewRecorded',
        {
          review_id: 'r1',
          card_id: recCardId,
          rating: 4,
          reviewed_at: tDay1 + 5000,
          tz_offset: 0,
          duration_ms: 800,
          answer_mode: 'flip',
          fsrs_params_version: 0,
          resulting_due_at: tDay1 + 4 * 86_400_000,
        },
        tDay1 + 5000,
      ),
    ]);

    const qLaterDay1 = buildStudyQueue(state, {
      deckId,
      nowMs: tDay1 + 3_600_000,
      tzOffsetMinutes: 0,
    });
    expect(qLaterDay1.queue).toHaveLength(0);
    expect(qLaterDay1.buriedNoteIds.has(noteId)).toBe(true);

    // On Day 2 after 04:00 rollover, Production sibling unburies and enters the queue
    const qDay2 = buildStudyQueue(state, { deckId, nowMs: tDay2, tzOffsetMinutes: 0 });
    expect(qDay2.queue).toHaveLength(1);
    expect(qDay2.queue[0]?.id).toBe(prodCardId);
  });

  it('respects new_cards_per_day limit', () => {
    const t0 = Date.UTC(2026, 4, 1, 10, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const deckId = 'deck-quota';
    const events = [
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Quota Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          settings: { new_cards_per_day: 2 },
        },
        t0,
      ),
    ];
    for (let i = 0; i < 5; i++) {
      events.push(
        factory.create(
          'NoteUpserted',
          {
            note_id: deriveNoteId(deckId, `k-${i}`),
            deck_id: deckId,
            source_key: `k-${i}`,
            fields: { word: `단어${i}`, meaning: `word ${i}` },
            created_order: i,
          },
          t0 + i,
        ),
      );
    }

    const state = replayAllEvents(events);
    const q = buildStudyQueue(state, { deckId, nowMs: t0 + 1000, tzOffsetMinutes: 0 });
    expect(q.counts.new).toBe(2);
    expect(q.queue).toHaveLength(2);
  });

  it('reports nextLearningDueAt for intraday learning cards and surfaces them once due', () => {
    const t0 = Date.UTC(2026, 4, 1, 10, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const deckId = 'deck-learn-wake';
    const noteId = deriveNoteId(deckId, 'n1');
    const cardId = deriveCardId(noteId, 'layout:vocab-ko:recognition', 0);

    const state = replayAllEvents([
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Learning Wake',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
        },
        t0,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: deckId,
          source_key: 'n1',
          fields: { word: '공부', meaning: 'study' },
        },
        t0,
      ),
      factory.create(
        'ReviewRecorded',
        {
          review_id: 'r-again',
          card_id: cardId,
          rating: 1, // Again -> short-term learning step (~1m later)
          reviewed_at: t0 + 1000,
          tz_offset: 0,
          duration_ms: 500,
          answer_mode: 'flip',
          fsrs_params_version: 0,
          resulting_due_at: t0 + 61_000,
        },
        t0 + 1000,
      ),
    ]);

    const qImmediately = buildStudyQueue(state, { deckId, nowMs: t0 + 2000, tzOffsetMinutes: 0 });
    expect(qImmediately.queue).toHaveLength(0);
    expect(qImmediately.nextLearningDueAt).toBeDefined();
    expect(qImmediately.nextLearningDueAt).toBeGreaterThan(t0 + 2000);

    const dueTime = qImmediately.nextLearningDueAt ?? t0 + 120_000;
    const qWhenDue = buildStudyQueue(state, { deckId, nowMs: dueTime, tzOffsetMinutes: 0 });
    expect(qWhenDue.counts.learning).toBe(1);
    expect(qWhenDue.queue[0]?.id).toBe(cardId);
  });
});
