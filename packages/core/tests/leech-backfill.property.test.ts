import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeStatePatch, mergeStatePatch } from '../src/events/patch.ts';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  replayAllEvents,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import { hasTagAddRegister, normalizeAddedTag } from '../src/events/tag-adds.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import type { ReviewRating } from '../src/model/types.ts';
import {
  filterCards,
  LEECH_CATEGORY,
  LEECH_LAPSE_THRESHOLD,
  planLeechBackfill,
} from '../src/study/filter.ts';
import { compareCodeUnits } from '../src/study/queue.ts';

const DECK = 'deck-ko-leech-backfill';
const LAYOUT = 'layout:vocab-ko:recognition';
const NOTE_KEYS = ['학교', '도서관', '약속'] as const;
const DAY = 86_400_000;
const MIN = 60_000;
const BASE = Date.UTC(2026, 0, 5, 1, 0, 0);
const noteIdFor = (i: number) => deriveNoteId(DECK, NOTE_KEYS[i] ?? '');
const cardIdFor = (i: number) => deriveCardId(noteIdFor(i), LAYOUT, 0);

function shuffleWithSeed<T>(arr: readonly T[], s: number): T[] {
  const copy = [...arr];
  let x = s || 1;
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

function replayChunked(list: readonly FlashEvent[], chunk: number): CollectionState {
  const st = createEmptyState();
  for (let i = 0; i < list.length; i += chunk) applyEvents(st, list.slice(i, i + chunk));
  return st;
}

/** A pre-leech-tagging log: one deck, tagged notes, and `lapses[i]` lapses on card `i`. */
function legacyLog(f: EventFactory, lapses: readonly number[]): FlashEvent[] {
  const events: FlashEvent[] = [
    f.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: '한국어',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      },
      BASE,
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
          fields: { word: key, meaning: `m${i}` },
          tags: ['topik-1'],
          created_order: i,
        },
        BASE + i + 1,
      ),
    );
  });
  let n = 0;
  lapses.forEach((count, i) => {
    let t = BASE + 10 * MIN + i * MIN;
    const ratings: ReviewRating[] = [3, 3];
    for (let k = 0; k < count; k++) ratings.push(1, 3, 3);
    for (const rating of ratings) {
      t += rating === 1 ? 3 * DAY : 10 * MIN;
      n += 1;
      events.push(
        f.create(
          'ReviewRecorded',
          {
            review_id: `legacy-${String(n).padStart(4, '0')}`,
            card_id: cardIdFor(i),
            rating,
            reviewed_at: t,
            tz_offset: 540,
            duration_ms: 1000,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: t,
          },
          t,
        ),
      );
    }
  });
  return events;
}

/** The events one device appends after running the backfill on its own view of the log. */
function backfillOn(view: readonly FlashEvent[], f: EventFactory, at: number): FlashEvent[] {
  return planLeechBackfill(replayAllEvents(view)).map((p) => f.create('NoteTagsAdded', p, at));
}

function observe(st: CollectionState) {
  const serialized = serializeCollectionState(st);
  return {
    notes: serialized.notes,
    fieldHlcs: serialized.fieldHlcs,
    unknown: serialized.unknownEvents.length,
    leechNotes: [
      ...new Set(
        filterCards(
          st,
          { categories: { mode: 'any', tags: [LEECH_CATEGORY] } },
          {
            nowMs: BASE + 400 * DAY,
            tzOffsetMinutes: 540,
          },
        ).map((c) => c.note_id),
      ),
    ].sort(compareCodeUnits),
  };
}

function expectNoDuplicateTags(st: CollectionState): void {
  for (const note of st.notes.values()) {
    const normalized = note.tags.map(normalizeAddedTag);
    expect(new Set(normalized).size).toBe(normalized.length);
  }
}

type ScenarioAction =
  | { kind: 'backfill'; device: number; seen: number; dt: number }
  | { kind: 'edit'; device: number; note: number; tags: string[]; dt: number };

/** The legacy log, then every action: a backfill on the device's own view, or a tag edit. */
function buildScenarioLog(
  lapses: readonly number[],
  actions: readonly ScenarioAction[],
): { events: FlashEvent[]; clock: number; f0: EventFactory } {
  // Skewed device clocks: HLC (not wall time) decides every register.
  const factories = [
    createEventFactory('dev-a', 0, createHlcState('dev-a', BASE)),
    createEventFactory('dev-b', 0, createHlcState('dev-b', BASE + 700)),
    createEventFactory('dev-c', 0, createHlcState('dev-c', BASE - 900)),
  ] as const;
  const [f0] = factories;
  const events = legacyLog(f0, lapses);
  const legacyCount = events.length;
  let clock = BASE + 200 * DAY;
  for (const act of actions) {
    clock += act.dt;
    const f = factories[act.device] ?? f0;
    events.push(...scenarioEvents(act, f, events, legacyCount, clock));
  }
  return { events, clock, f0 };
}

function scenarioEvents(
  act: ScenarioAction,
  f: EventFactory,
  events: readonly FlashEvent[],
  legacyCount: number,
  clock: number,
): FlashEvent[] {
  if (act.kind === 'backfill') {
    // The device has synced a prefix of the log, plus everything it wrote itself.
    const cut = legacyCount + Math.floor(act.seen * (events.length - legacyCount));
    const view = events.filter((ev, i) => i < cut || ev.device === f.deviceId);
    return backfillOn(view, f, clock);
  }
  const payload = {
    note_id: noteIdFor(act.note),
    deck_id: DECK,
    source_key: NOTE_KEYS[act.note] ?? '',
    fields: {},
    tags: act.tags,
  };
  return [f.create('NoteUpserted', payload, clock)];
}

function hydrateAfterPrefix(events: readonly FlashEvent[], seed: number): CollectionState {
  const shuffled = shuffleWithSeed(events, seed);
  const cut = Math.floor(shuffled.length / 2);
  const snapshot = serializeCollectionState(replayChunked(shuffled.slice(0, cut), 3));
  const hydrated = deserializeCollectionState(
    JSON.parse(JSON.stringify(snapshot)) as typeof snapshot,
  );
  applyEvents(hydrated, shuffled.slice(cut));
  return hydrated;
}

/** Every leech card's note carries the tag, unless its `leech` tag was removed after an add. */
function expectLeechesTaggedOrRemoved(st: CollectionState): void {
  for (const card of st.cards.values()) {
    if (card.schedule.lapses < LEECH_LAPSE_THRESHOLD) continue;
    const tags = st.notes.get(card.note_id)?.tags ?? [];
    const tagged = tags.some((t) => normalizeAddedTag(t) === LEECH_CATEGORY);
    expect(tagged || hasTagAddRegister(st, card.note_id, LEECH_CATEGORY)).toBe(true);
  }
}

function checkScenario(
  lapses: readonly number[],
  actions: readonly ScenarioAction[],
  seed: number,
): void {
  const { events, clock, f0 } = buildScenarioLog(lapses, actions);
  const reference = replayAllEvents(events);
  const expected = observe(reference);
  expectNoDuplicateTags(reference);
  const orders: FlashEvent[][] = [
    [...events].reverse(),
    shuffleWithSeed(events, seed),
    [...shuffleWithSeed(events, seed + 1), ...shuffleWithSeed(events, seed + 2).slice(0, 5)],
  ];
  for (const [i, order] of orders.entries()) {
    expect(observe(replayChunked(order, i + 1))).toEqual(expected);
  }
  // Snapshot of a shuffled prefix, the rest delivered after hydration.
  expect(observe(hydrateAfterPrefix(events, seed + 3)).notes).toEqual(expected.notes);
  // A final backfill on the merged log settles every leech; running it again plans nothing.
  const final = replayAllEvents([...events, ...backfillOn(events, f0, clock + DAY)]);
  expect(planLeechBackfill(final)).toEqual([]);
  expectLeechesTaggedOrRemoved(final);
}

const LEECHY = [LEECH_LAPSE_THRESHOLD, 2, LEECH_LAPSE_THRESHOLD + 1];

describe('leech backfill (NoteTagsAdded)', () => {
  it('tags only notes whose cards already have 8+ lapses, keeping their other tags', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const log = legacyLog(f, LEECHY);
    const before = replayAllEvents(log);
    expect(before.cards.get(cardIdFor(0))?.schedule.lapses).toBe(LEECH_LAPSE_THRESHOLD);
    expect(before.cards.get(cardIdFor(1))?.schedule.lapses).toBe(2);
    const plan = planLeechBackfill(before);
    expect(plan).toEqual(
      [noteIdFor(0), noteIdFor(2)]
        .sort(compareCodeUnits)
        .map((note_id) => ({ note_id, tags: ['leech'], reason: 'leech-backfill' })),
    );
    const after = replayAllEvents([...log, ...backfillOn(log, f, BASE + 300 * DAY)]);
    expect(after.notes.get(noteIdFor(0))?.tags).toEqual(['topik-1', 'leech']);
    expect(after.notes.get(noteIdFor(1))?.tags).toEqual(['topik-1']);
    expect(after.notes.get(noteIdFor(2))?.tags).toEqual(['topik-1', 'leech']);
  });

  it('is idempotent: a second run plans nothing, and replaying an event twice changes nothing', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const log = legacyLog(f, LEECHY);
    const first = backfillOn(log, f, BASE + 300 * DAY);
    const once = [...log, ...first];
    expect(planLeechBackfill(replayAllEvents(once))).toEqual([]);
    const st = replayAllEvents(once);
    applyEvents(st, first); // Duplicate delivery is ignored by event id.
    expect(observe(st)).toEqual(observe(replayAllEvents(once)));
    // A re-run under a new event id (e.g. after a reinstall) still converges to the same tags.
    const again = first.map((ev) =>
      f.create('NoteTagsAdded', ev.payload as never, BASE + 301 * DAY),
    );
    const twice = replayAllEvents([...once, ...again]);
    expectNoDuplicateTags(twice);
    expect(twice.notes.get(noteIdFor(0))?.tags).toEqual(['topik-1', 'leech']);
  });

  it('two devices backfilling concurrently converge to one leech tag, keeping a concurrent edit', () => {
    const fa = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const fb = createEventFactory('dev-b', 0, createHlcState('dev-b', BASE + 500));
    const fc3 = createEventFactory('dev-c', 0, createHlcState('dev-c', BASE - 700));
    const log = legacyLog(fa, LEECHY);
    // Both devices see the same legacy log and backfill at (almost) the same time.
    const a = backfillOn(log, fa, BASE + 300 * DAY);
    const b = backfillOn(log, fb, BASE + 300 * DAY + 5);
    // Device C, not synced yet, edits note 0's tags a moment before the backfills.
    const edit = fc3.create(
      'NoteUpserted',
      {
        note_id: noteIdFor(0),
        deck_id: DECK,
        source_key: NOTE_KEYS[0],
        fields: {},
        tags: ['topik-1', 'daily'],
      },
      BASE + 300 * DAY - 10,
    );
    const merged = [...log, ...a, ...b, edit];
    const reference = replayAllEvents(merged);
    expectNoDuplicateTags(reference);
    // Set-union: the concurrent edit survives and the leech tag appears exactly once.
    expect(reference.notes.get(noteIdFor(0))?.tags).toEqual(['topik-1', 'daily', 'leech']);
    expect(reference.notes.get(noteIdFor(2))?.tags).toEqual(['topik-1', 'leech']);
    expect(planLeechBackfill(reference)).toEqual([]);
    for (const [i, order] of [
      [...merged].reverse(),
      shuffleWithSeed(merged, 7),
      shuffleWithSeed(merged, 99),
    ].entries()) {
      expect(observe(replayChunked(order, i + 2))).toEqual(observe(reference));
    }
  });

  it('a tag edit made after the backfill wins, and the backfill never re-adds a removed tag', () => {
    const fa = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const fb = createEventFactory('dev-b', 0, createHlcState('dev-b', BASE));
    const log = legacyLog(fa, LEECHY);
    const added = backfillOn(log, fa, BASE + 300 * DAY);
    const removal = fa.create(
      'NoteUpserted',
      {
        note_id: noteIdFor(0),
        deck_id: DECK,
        source_key: NOTE_KEYS[0],
        fields: {},
        tags: ['topik-1'],
      },
      BASE + 301 * DAY,
    );
    const st = replayAllEvents([...log, ...added, removal]);
    expect(st.notes.get(noteIdFor(0))?.tags).toEqual(['topik-1']);
    expect(hasTagAddRegister(st, noteIdFor(0), LEECH_CATEGORY)).toBe(true);
    // Device B (synced) runs the backfill later: note 0 stays untagged, note 2 keeps its tag.
    expect(planLeechBackfill(st)).toEqual([]);
    expect(backfillOn([...log, ...added, removal], fb, BASE + 302 * DAY)).toEqual([]);
  });

  it('survives snapshots, Worker patches and older-build snapshots that kept it as unknown', () => {
    const fa = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const log = legacyLog(fa, LEECHY);
    const added = backfillOn(log, fa, BASE + 300 * DAY);
    const reference = replayAllEvents([...log, ...added]);

    // Snapshot of the log before the adds, adds delivered after hydration.
    const hydrated = deserializeCollectionState(
      JSON.parse(JSON.stringify(serializeCollectionState(replayAllEvents(log)))) as ReturnType<
        typeof serializeCollectionState
      >,
    );
    applyEvents(hydrated, added);
    expect(observe(hydrated).notes).toEqual(observe(reference).notes);

    // Worker patch merged into a main-thread state, then a local tag edit on the main thread.
    const worker = replayAllEvents(log);
    const main = replayAllEvents(log);
    mergeStatePatch(main, computeStatePatch(worker, added));
    expect(observe(main)).toEqual(observe(reference));
    // A device that has not synced edits the tags at an older HLC than the add.
    const offline = createEventFactory('dev-z', 0, createHlcState('dev-z', BASE));
    const edit = offline.create(
      'NoteUpserted',
      {
        note_id: noteIdFor(2),
        deck_id: DECK,
        source_key: NOTE_KEYS[2],
        fields: {},
        tags: ['topik-2'],
      },
      BASE + 200 * DAY, // Older than the add: the add survives on both threads.
    );
    applyEvents(main, [edit]);
    expect(main.notes.get(noteIdFor(2))?.tags).toEqual(['topik-2', 'leech']);

    // An older build kept the adds in `unknownEvents` and snapshotted them.
    const older = serializeCollectionState(replayAllEvents(log));
    older.unknownEvents = added.map((ev) => JSON.parse(JSON.stringify(ev)) as never);
    const upgraded = deserializeCollectionState(older);
    expect(upgraded.unknownEvents).toEqual([]);
    expect(observe(upgraded).notes).toEqual(observe(reference).notes);
  });

  it('hydrating an older build snapshot that kept the add registers but dropped the tag equals a full replay', () => {
    const fa = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
    const log = legacyLog(fa, LEECHY);
    const added = backfillOn(log, fa, BASE + 300 * DAY);
    // A tag edit newer than the tags register but older than the add: the add still wins.
    const offline = createEventFactory('dev-z', 0, createHlcState('dev-z', BASE));
    const edit = offline.create(
      'NoteUpserted',
      {
        note_id: noteIdFor(0),
        deck_id: DECK,
        source_key: NOTE_KEYS[0],
        fields: {},
        tags: ['topik-2'],
      },
      BASE + 200 * DAY,
    );
    const reference = replayAllEvents([...log, ...added, edit]);
    expect(reference.notes.get(noteIdFor(0))?.tags).toEqual(['topik-2', 'leech']);

    // The older build hydrated the new snapshot (registers kept verbatim in fieldHlcs), applied
    // the edit with plain LWW and wrote a snapshot without the winning add in `note.tags`.
    const snapshot = serializeCollectionState(reference);
    const index = snapshot.notes.findIndex((n) => n.id === noteIdFor(0));
    const note0 = snapshot.notes[index];
    if (!note0) throw new Error('note 0 missing');
    snapshot.notes[index] = { ...note0, tags: ['topik-2'] };

    const hydrated = deserializeCollectionState(snapshot);
    expect(hydrated.notes.get(noteIdFor(0))?.tags).toEqual(['topik-2', 'leech']);
    expect(observe(hydrated).notes).toEqual(observe(reference).notes);
    expect(observe(hydrated).fieldHlcs).toEqual(observe(reference).fieldHlcs);
  });

  // CPU-bound: 120 replayed scenarios take about 0.7 s idle and several times that when parallel gates share the
  // machine, so this one test gets 20 s rather than fewer runs.
  it(
    'converges under any concurrent backfills, tag edits, delivery order and chunking (property)',
    {
      timeout: 20_000,
    },
    () => {
      const tagArb = fc.constantFrom('topik-1', 'daily', 'leech', 'Leech', 'grammar::verbs');
      const actionArb: fc.Arbitrary<ScenarioAction> = fc.oneof(
        fc.record({
          kind: fc.constant('backfill' as const),
          device: fc.integer({ min: 0, max: 2 }),
          seen: fc.double({ min: 0, max: 1, noNaN: true }),
          dt: fc.integer({ min: -5_000, max: 60_000 }),
        }),
        fc.record({
          kind: fc.constant('edit' as const),
          device: fc.integer({ min: 0, max: 2 }),
          note: fc.integer({ min: 0, max: 2 }),
          tags: fc.uniqueArray(tagArb, { maxLength: 3, selector: (t) => t.toLowerCase() }),
          dt: fc.integer({ min: -5_000, max: 60_000 }),
        }),
      );
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: LEECH_LAPSE_THRESHOLD + 2 }), {
            minLength: 3,
            maxLength: 3,
          }),
          fc.array(actionArb, { minLength: 1, maxLength: 12 }),
          fc.integer({ min: 1, max: 100_000 }),
          (lapses, actions, seed) => checkScenario(lapses, actions, seed),
        ),
        { numRuns: 120 },
      );
    },
  );
});
