import { describe, expect, it } from 'vitest';
import { computeStatePatch, mergeStatePatch } from '../src/events/patch.ts';
import {
  createEventFactory,
  isCardSuspended,
  replayAllEvents,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import {
  isKnownEventType,
  type FlashEvent,
  type KnownEvent,
  type StudySetMode,
} from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId, FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import type { ReviewRating } from '../src/model/types.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import { computeCollectionStats } from '../src/stats/stats.ts';
import {
  buildPracticeQueue,
  buildReviewAheadQueue,
  buildStudySetSavedPayload,
  cardFilterToStatsFilter,
  getPracticeRecords,
  listStudySets,
  normalizeStudySetName,
} from '../src/study/custom-study.ts';
import {
  applyFilterPreset,
  filterCards,
  LEECH_LAPSE_THRESHOLD,
  normalizeCardFilter,
  shouldAutoSuspendLeech,
} from '../src/study/filter.ts';
import { buildStudyQueue, getExtraNewCardsToday } from '../src/study/queue.ts';

const DAY = 86_400_000;
const MIN = 60_000;
const KST = 540;
/** 2026-03-10 12:00 KST, well after the 04:00 rollover. */
const NOW = Date.UTC(2026, 2, 10, 3, 0, 0);
const KO_DECK = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
const JA_DECK = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ja-vocab');
const REC = 'layout:vocab-ko:recognition';
const PROD = 'layout:vocab-ko:production';
const koNote = (n: number) => deriveNoteId(KO_DECK, `ko-${n}`);
const koCard = (n: number, layout = REC) => deriveCardId(koNote(n), layout, 0);
const SCOPE = { nowMs: NOW, tzOffsetMinutes: KST };

interface Fixture {
  factory: EventFactory;
  events: FlashEvent[];
  review: (cardId: string, rating: ReviewRating, at: number) => void;
  practice: (cardId: string, rating: ReviewRating, at: number, sessionId?: string) => string;
  state: () => CollectionState;
}

function makeFixture(deviceId = 'dev-a'): Fixture {
  const factory = createEventFactory(deviceId, 0, createHlcState(deviceId, SAMPLE_SEED_EPOCH_MS));
  const events: FlashEvent[] = buildSampleDeckEvents(factory);
  // Enable the Production layout so every Korean note has two sibling cards.
  events.push(
    factory.create(
      'DeckSettingsChanged',
      { deck_id: KO_DECK, settings: { enabled_layout_ids: [PROD, REC] } },
      SAMPLE_SEED_EPOCH_MS + 1000,
    ),
  );
  let n = 0;
  return {
    factory,
    events,
    review(cardId, rating, at) {
      n += 1;
      events.push(
        factory.create(
          'ReviewRecorded',
          {
            review_id: `rev-${String(n).padStart(4, '0')}`,
            card_id: cardId,
            rating,
            reviewed_at: at,
            tz_offset: KST,
            duration_ms: 2000,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: at,
          },
          at,
        ),
      );
    },
    practice(cardId, rating, at, sessionId = 'session-1') {
      n += 1;
      const practiceId = `prac-${String(n).padStart(4, '0')}`;
      events.push(
        factory.create(
          'PracticeRecorded',
          {
            practice_id: practiceId,
            session_id: sessionId,
            card_id: cardId,
            rating,
            practiced_at: at,
            tz_offset: KST,
            duration_ms: 1500,
            answer_mode: 'flip',
          },
          at,
        ),
      );
      return practiceId;
    },
    state: () => replayAllEvents(events),
  };
}

/** 학교 graduated long ago and is due today; 도서관 is due in a few days; 약속 later still. */
function reviewedHistory(): Fixture {
  const fx = makeFixture();
  fx.review(koCard(1), 3, NOW - 40 * DAY);
  fx.review(koCard(1), 3, NOW - 40 * DAY + 10 * MIN);
  fx.review(koCard(2), 3, NOW - DAY);
  fx.review(koCard(2), 3, NOW - DAY + 10 * MIN);
  fx.review(koCard(3), 4, NOW - DAY);
  return fx;
}

function saveSet(
  fx: Fixture,
  at: number,
  input: { setId: string; name?: string; filter?: unknown; mode?: StudySetMode },
): void {
  const payload = buildStudySetSavedPayload(input);
  if (!payload) throw new Error('invalid study set payload');
  fx.events.push(fx.factory.create('StudySetSaved', payload, at));
}

describe('Phase 9 study-side events are log-retained and forward compatible', () => {
  it('are not replayed by applyKnownEvent but kept verbatim in unknownEvents', () => {
    for (const type of [
      'StudySetSaved',
      'StudySetDeleted',
      'PracticeRecorded',
      'PracticeUndone',
      'NewCardLimitRaised',
    ]) {
      expect(isKnownEventType(type)).toBe(false);
    }
    const fx = makeFixture();
    saveSet(fx, NOW, { setId: 'set-1', name: 'Hanja', filter: { deckIds: [KO_DECK] } });
    fx.practice(koCard(1), 3, NOW);
    const st = fx.state();
    expect(st.unknownEvents.map((e) => e.type)).toEqual(['StudySetSaved', 'PracticeRecorded']);
  });

  it('round-trip through snapshots, Worker patches and an older build unchanged', () => {
    const fx = makeFixture();
    saveSet(fx, NOW - DAY, {
      setId: 'set-1',
      name: '  Hanja   words ',
      filter: { categories: { mode: 'any', tags: ['Hanja'] } },
      mode: 'practice',
    });
    fx.practice(koCard(2), 1, NOW - MIN);
    const st = fx.state();
    const restored = deserializeCollectionState(
      JSON.parse(JSON.stringify(serializeCollectionState(st))) as ReturnType<
        typeof serializeCollectionState
      >,
    );
    expect(listStudySets(restored)).toEqual(listStudySets(st));
    expect(getPracticeRecords(restored)).toEqual(getPracticeRecords(st));

    // Worker -> main thread patch carries them like any unknown event.
    const worker = replayAllEvents(fx.events.slice(0, -2));
    const main = replayAllEvents(fx.events.slice(0, -2));
    mergeStatePatch(main, computeStatePatch(worker, fx.events.slice(-2) as KnownEvent[]));
    expect(listStudySets(main)).toEqual(listStudySets(st));
    expect(getPracticeRecords(main)).toHaveLength(1);

    // An older build serializes `unknownEvents` verbatim, so the snapshot is identical.
    const legacy = replayAllEvents(
      fx.events.map((e) =>
        e.type === 'StudySetSaved' || e.type === 'PracticeRecorded' ? { ...e } : e,
      ),
    );
    expect(serializeCollectionState(legacy).unknownEvents).toEqual(
      serializeCollectionState(st).unknownEvents,
    );
  });
});

describe('Phase 9 Study Sets', () => {
  it('normalizes names and payloads (golden)', () => {
    expect(normalizeStudySetName('  Trouble \n  verbs ')).toBe('Trouble verbs');
    expect(normalizeStudySetName('   ')).toBeUndefined();
    expect(normalizeStudySetName('x'.repeat(200))).toHaveLength(80);
    expect(
      buildStudySetSavedPayload({
        setId: 's',
        name: ' 한자 ',
        filter: { deckIds: [KO_DECK, KO_DECK], categories: { mode: 'all', tags: ['Hanja', ''] } },
        mode: 'schedule',
      }),
    ).toEqual({
      set_id: 's',
      name: '한자',
      filter: { deckIds: [KO_DECK], categories: { mode: 'all', tags: ['hanja'] } },
      mode: 'schedule',
    });
    expect(buildStudySetSavedPayload({ setId: 's', name: '  ' })).toBeUndefined();
    expect(buildStudySetSavedPayload({ setId: 's' })).toBeUndefined();
  });

  it('creates, renames, edits, deletes and resurrects with per-field LWW (golden)', () => {
    const fx = makeFixture();
    const trouble = applyFilterPreset({ deckIds: [KO_DECK] }, 'trouble-cards');
    saveSet(fx, NOW - 3 * DAY, { setId: 'b', name: 'Korean trouble', filter: trouble });
    saveSet(fx, NOW - 3 * DAY + 1, {
      setId: 'a',
      name: 'Hanja',
      filter: { categories: { mode: 'any', tags: ['hanja'] } },
      mode: 'practice',
    });
    saveSet(fx, NOW - 2 * DAY, { setId: 'b', name: 'Korean leeches' });
    saveSet(fx, NOW - 2 * DAY + 1, { setId: 'b', mode: 'practice' });
    expect(listStudySets(fx.state())).toEqual([
      {
        id: 'a',
        name: 'Hanja',
        filter: { categories: { mode: 'any', tags: ['hanja'] } },
        mode: 'practice',
      },
      {
        id: 'b',
        name: 'Korean leeches',
        filter: { deckIds: [KO_DECK], performance: { minAgainCount: 1, hardest: 50 } },
        mode: 'practice',
      },
    ]);

    fx.events.push(fx.factory.create('StudySetDeleted', { set_id: 'a' }, NOW - DAY));
    expect(listStudySets(fx.state()).map((s) => s.id)).toEqual(['b']);
    // A later edit (e.g. a rename on another device after the delete) brings it back.
    saveSet(fx, NOW, { setId: 'a', name: 'Hanja again' });
    expect(listStudySets(fx.state()).map((s) => [s.id, s.name, s.mode])).toEqual([
      ['a', 'Hanja again', 'practice'],
      ['b', 'Korean leeches', 'practice'],
    ]);
  });

  it('concurrent rename and filter edit on two devices both survive', () => {
    const a = makeFixture('dev-a');
    saveSet(a, NOW - DAY, { setId: 's', name: 'Verbs', filter: { deckIds: [JA_DECK] } });
    const b = createEventFactory('dev-b', 0, createHlcState('dev-b', NOW));
    const rename = b.create('StudySetSaved', { set_id: 's', name: 'Japanese verbs' }, NOW);
    const edit = a.factory.create(
      'StudySetSaved',
      { set_id: 's', filter: normalizeCardFilter({ deckIds: [JA_DECK], states: ['due'] }) },
      NOW + 5,
    );
    const one = replayAllEvents([...a.events, rename, edit]);
    const two = replayAllEvents([edit, ...a.events.slice().reverse(), rename]);
    expect(listStudySets(one)).toEqual(listStudySets(two));
    expect(listStudySets(one)).toEqual([
      {
        id: 's',
        name: 'Japanese verbs',
        filter: { deckIds: [JA_DECK], states: ['due'] },
        mode: 'schedule',
      },
    ]);
  });

  it('ignores malformed study-set payloads', () => {
    const fx = makeFixture();
    const good = fx.factory.create('StudySetSaved', { set_id: 'ok', name: 'Fine' }, NOW);
    const bad = [
      { ...good, id: 'x1', payload: null },
      { ...good, id: 'x2', payload: { set_id: 3, name: 'n' } },
      { ...good, id: 'x3', payload: { set_id: 'z', name: 42, mode: 'weird' } },
    ] as unknown as FlashEvent[];
    const st = replayAllEvents([...fx.events, good, ...bad]);
    expect(listStudySets(st).map((s) => s.id)).toEqual(['ok']);
  });
});

describe('Phase 9 cram / practice (PracticeRecorded never changes FSRS)', () => {
  it('replay with and without practice events gives identical schedules and queues', () => {
    const fx = reviewedHistory();
    const without = fx.state();
    const p1 = fx.practice(koCard(1), 1, NOW - 2 * MIN);
    fx.practice(koCard(1), 4, NOW - MIN);
    fx.practice(koCard(4), 1, NOW - MIN);
    fx.events.push(fx.factory.create('PracticeUndone', { practice_id: p1 }, NOW));
    const withPractice = fx.state();
    expect([...withPractice.cards.entries()]).toEqual([...without.cards.entries()]);
    expect(buildStudyQueue(withPractice, SCOPE)).toEqual(buildStudyQueue(without, SCOPE));
    expect(buildStudyQueue(withPractice, { ...SCOPE, deckId: KO_DECK })).toEqual(
      buildStudyQueue(without, { ...SCOPE, deckId: KO_DECK }),
    );
  });

  it('queues every match, advances on answers, re-queues Again and keeps sibling burying', () => {
    const fx = reviewedHistory();
    const filter = normalizeCardFilter({ deckIds: [KO_DECK] });
    const opts = { ...SCOPE, filter, sessionId: 'session-1' };
    let q = buildPracticeQueue(fx.state(), opts);
    // One card per note (siblings buried within the session), due dates ignored.
    expect(q.queue).toHaveLength(4);
    expect(new Set(q.queue.map((c) => c.note_id)).size).toBe(4);
    expect(q.practiced).toBe(0);

    const first = q.queue[0];
    if (!first) throw new Error('empty practice queue');
    fx.practice(first.id, 1, NOW + MIN);
    q = buildPracticeQueue(fx.state(), opts);
    expect(q.queue[q.queue.length - 1]?.id).toBe(first.id);
    expect(q.again).toBe(1);

    fx.practice(first.id, 3, NOW + 2 * MIN);
    q = buildPracticeQueue(fx.state(), opts);
    expect(q.queue.map((c) => c.id)).not.toContain(first.id);
    expect(q.practiced).toBe(1);
    expect(q.queue).toHaveLength(3);
    // The practiced card's sibling stays buried for the rest of the session.
    expect(q.buriedNoteIds.has(first.note_id)).toBe(true);

    // Another session starts fresh; FSRS is still untouched.
    const other = buildPracticeQueue(fx.state(), { ...opts, sessionId: 'session-2' });
    expect(other.queue).toHaveLength(4);
  });

  it('buries siblings of cards reviewed today, never the reviewed card itself', () => {
    const fx = makeFixture();
    fx.review(koCard(2, PROD), 3, NOW - 30 * MIN);
    const q = buildPracticeQueue(fx.state(), {
      ...SCOPE,
      filter: normalizeCardFilter({ deckIds: [KO_DECK] }),
      sessionId: 's',
    });
    const ids = q.queue.map((c) => c.id);
    expect(ids).toContain(koCard(2, PROD));
    expect(ids).not.toContain(koCard(2, REC));
  });

  it('honours the filter order (hardest first) and excludes suspended cards (golden)', () => {
    const fx = reviewedHistory();
    fx.review(koCard(2), 1, NOW - 2 * DAY);
    fx.review(koCard(3), 1, NOW - 2 * DAY + MIN);
    fx.review(koCard(3), 1, NOW - 2 * DAY + 2 * MIN);
    fx.events.push(fx.factory.create('CardSuspended', { card_id: koCard(1) }, NOW - DAY));
    const st = fx.state();
    const filter = applyFilterPreset({ deckIds: [KO_DECK] }, 'trouble-cards');
    const q = buildPracticeQueue(st, { ...SCOPE, filter, sessionId: 's' });
    expect(q.queue.map((c) => c.id)).toEqual(
      filterCards(st, filter, { ...SCOPE, excludeSuspended: true }).map((c) => c.id),
    );
    expect(q.queue.map((c) => c.id)).toEqual([koCard(3), koCard(2)]);
    expect(q.queue.map((c) => c.id)).not.toContain(koCard(1));
  });

  it('PracticeUndone removes an answer from the session', () => {
    const fx = makeFixture();
    const filter = normalizeCardFilter({ deckIds: [KO_DECK] });
    const opts = { ...SCOPE, filter, sessionId: 'session-1' };
    const firstId = buildPracticeQueue(fx.state(), opts).queue[0]?.id ?? '';
    const pid = fx.practice(firstId, 3, NOW);
    expect(buildPracticeQueue(fx.state(), opts).practiced).toBe(1);
    fx.events.push(fx.factory.create('PracticeUndone', { practice_id: pid }, NOW + 1));
    const q = buildPracticeQueue(fx.state(), opts);
    expect(q.practiced).toBe(0);
    expect(q.queue[0]?.id).toBe(firstId);
  });
});

describe('Phase 9 custom study: review ahead', () => {
  it('queues review cards due within N days, never new cards (golden)', () => {
    const st = reviewedHistory().state();
    const due = (id: string) => st.cards.get(id)?.schedule.due ?? 0;
    expect(due(koCard(1))).toBeLessThan(NOW);
    const normal = buildStudyQueue(st, { ...SCOPE, deckId: KO_DECK });
    expect(normal.counts.due).toBe(1);

    const ahead1 = buildReviewAheadQueue(st, { ...SCOPE, deckId: KO_DECK, days: 1 });
    const ahead30 = buildReviewAheadQueue(st, { ...SCOPE, deckId: KO_DECK, days: 30 });
    expect(ahead30.queue.map((c) => c.id)).toEqual(
      [koCard(1), koCard(2), koCard(3)].sort((a, b) => due(a) - due(b)),
    );
    expect(ahead30.counts).toEqual({ new: 0, learning: 0, due: 3, total: 3 });
    expect(ahead1.queue.length).toBeLessThan(ahead30.queue.length);
    expect(ahead1.queue.every((c) => c.schedule.state !== 0)).toBe(true);
  });

  it('keeps sibling burying, respects the filter and suspension', () => {
    const fx = reviewedHistory();
    fx.review(koCard(3, PROD), 3, NOW - 2 * MIN);
    fx.events.push(fx.factory.create('CardSuspended', { card_id: koCard(2) }, NOW - MIN));
    const st = fx.state();
    const ahead = buildReviewAheadQueue(st, { ...SCOPE, deckId: KO_DECK, days: 30 });
    expect(ahead.queue.map((c) => c.id)).toEqual([koCard(1)]);
    expect(ahead.buriedNoteIds.has(koNote(3))).toBe(true);
    const filtered = buildReviewAheadQueue(st, {
      ...SCOPE,
      days: 30,
      filter: normalizeCardFilter({ categories: { mode: 'any', tags: ['places'] } }),
    });
    expect(filtered.queue).toHaveLength(0);
  });
});

describe('Phase 9 custom study: extra new cards today', () => {
  function limited(): Fixture {
    const fx = makeFixture();
    fx.events.push(
      fx.factory.create(
        'DeckSettingsChanged',
        { deck_id: KO_DECK, settings: { new_cards_per_day: 1 } },
        NOW - 5 * DAY,
      ),
    );
    return fx;
  }
  const raise = (fx: Fixture, raiseId: string, extra: number, at: number, deckIds = [KO_DECK]) =>
    fx.events.push(
      fx.factory.create(
        'NewCardLimitRaised',
        { raise_id: raiseId, deck_ids: deckIds, extra, raised_at: at, tz_offset: KST },
        at,
      ),
    );

  it('raises today only, adds up, dedupes raise ids and never touches FSRS', () => {
    const fx = limited();
    const before = fx.state();
    expect(buildStudyQueue(before, { ...SCOPE, deckId: KO_DECK }).counts.new).toBe(1);

    raise(fx, 'r-yesterday', 5, NOW - DAY);
    raise(fx, 'r-other-deck', 5, NOW - MIN, [JA_DECK]);
    expect(buildStudyQueue(fx.state(), { ...SCOPE, deckId: KO_DECK }).counts.new).toBe(1);

    raise(fx, 'r1', 1, NOW - 2 * MIN);
    raise(fx, 'r2', 1, NOW - MIN, []);
    const dup = fx.events[fx.events.length - 1] as FlashEvent;
    fx.events.push({ ...dup, id: `${dup.id}-dup`, hlc: `${dup.hlc}x` });
    const st = fx.state();
    expect(getExtraNewCardsToday(st, KO_DECK, NOW, KST, 4)).toBe(2);
    expect(buildStudyQueue(st, { ...SCOPE, deckId: KO_DECK }).counts.new).toBe(3);
    expect([...st.cards.entries()]).toEqual([...before.cards.entries()]);
    // Tomorrow the normal limit is back.
    expect(buildStudyQueue(st, { ...SCOPE, nowMs: NOW + DAY, deckId: KO_DECK }).counts.new).toBe(1);
  });
});

describe('Phase 9 leech auto-suspend (default off)', () => {
  it('fires only on the review that crosses the threshold, with the setting on', () => {
    const fx = makeFixture();
    const st = fx.state();
    const t = LEECH_LAPSE_THRESHOLD;
    expect(shouldAutoSuspendLeech(st, koCard(1), t - 1, t)).toBe(false);
    fx.events.push(
      fx.factory.create('PreferencesChanged', { preferences: { leech_auto_suspend: true } }, NOW),
    );
    const on = fx.state();
    expect(on.preferences.leech_auto_suspend).toBe(true);
    expect(shouldAutoSuspendLeech(on, koCard(1), t - 1, t)).toBe(true);
    expect(shouldAutoSuspendLeech(on, koCard(1), t, t + 1)).toBe(false);
    expect(shouldAutoSuspendLeech(on, koCard(1), t - 2, t - 1)).toBe(false);
    fx.events.push(
      fx.factory.create(
        'CardSuspended',
        { card_id: koCard(1), reason: 'leech', review_id: 'r' },
        NOW + 1,
      ),
    );
    const suspended = fx.state();
    expect(isCardSuspended(suspended, koCard(1))).toBe(true);
    expect(shouldAutoSuspendLeech(suspended, koCard(1), t - 1, t)).toBe(false);
  });

  it('the setting is a synced LWW preference', () => {
    const a = makeFixture('dev-a');
    const b = createEventFactory('dev-b', 0, createHlcState('dev-b', NOW));
    const on = a.factory.create(
      'PreferencesChanged',
      { preferences: { leech_auto_suspend: true } },
      NOW,
    );
    const off = b.create('PreferencesChanged', { preferences: { leech_auto_suspend: false } }, NOW);
    const x = replayAllEvents([...a.events, on, off]);
    const y = replayAllEvents([off, ...a.events, on]);
    expect(x.preferences.leech_auto_suspend).toBe(y.preferences.leech_auto_suspend);
  });
});

describe('Phase 9 filter -> Phase 11 stats bridge', () => {
  it('selects exactly the filtered cards', () => {
    const fx = reviewedHistory();
    fx.review(koCard(2), 1, NOW - DAY);
    const st = fx.state();
    const filter = normalizeCardFilter({ categories: { mode: 'any', tags: ['places'] } });
    const stats = computeCollectionStats(st, {
      ...SCOPE,
      filter: cardFilterToStatsFilter(st, filter, SCOPE),
    });
    expect(stats.totals.cards).toBe(filterCards(st, filter, SCOPE).length);
    expect(stats.totals.cards).toBe(2);
    const deckOnly = cardFilterToStatsFilter(st, { deckIds: [KO_DECK] }, SCOPE);
    expect(deckOnly.includeCard).toBeUndefined();
    expect([...(deckOnly.deckIds ?? [])]).toEqual([KO_DECK]);
  });
});
