import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createEventFactory, replayAllEvents, type CollectionState } from '../src/events/replay.ts';
import type { KnownEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId, FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import type { ReviewRating } from '../src/model/types.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import type { CardFilterContext } from '../src/study/filter.ts';
import { buildStudyQueue } from '../src/study/queue.ts';
import {
  isValidReminderTime,
  nextReminderOccurrences,
  planStudyReminders,
} from '../src/study/reminders.ts';
import { filterBrowseNoteIds, noteMatchesSearchText, searchNotes } from '../src/tags/browse.ts';

const DAY = 86_400_000;
const MIN = 60_000;
const KST = 540;
/** 2026-03-10 03:00 UTC = 12:00 KST. */
const NOW = Date.UTC(2026, 2, 10, 3, 0, 0);
const CTX: CardFilterContext = { nowMs: NOW, tzOffsetMinutes: KST };
const KO_DECK = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
const REC = 'layout:vocab-ko:recognition';
const koNote = (n: number) => deriveNoteId(KO_DECK, `ko-${n}`);
const koCard = (n: number) => deriveCardId(koNote(n), REC, 0);

function sampleWorld(): {
  events: KnownEvent[];
  review: (n: number, r: ReviewRating, at: number) => void;
} {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', SAMPLE_SEED_EPOCH_MS));
  const events: KnownEvent[] = buildSampleDeckEvents(factory);
  let count = 0;
  return {
    events,
    review(n, rating, at) {
      count += 1;
      events.push(
        factory.create(
          'ReviewRecorded',
          {
            review_id: `rev-${String(count).padStart(4, '0')}`,
            card_id: koCard(n),
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
  };
}

function sampleState(): CollectionState {
  return replayAllEvents(sampleWorld().events);
}

const fixedOffset = (minutes: number) => () => minutes;

/** Wall-clock hour:minute of an instant under a UTC offset. */
function localHourMinute(atMs: number, tzOffsetMinutes: number): [number, number] {
  const d = new Date(atMs + tzOffsetMinutes * MIN);
  return [d.getUTCHours(), d.getUTCMinutes()];
}

describe('Phase 13 study reminders (core)', () => {
  it('validates the time of day', () => {
    expect(isValidReminderTime({ hour: 0, minute: 0 })).toBe(true);
    expect(isValidReminderTime({ hour: 23, minute: 59 })).toBe(true);
    expect(isValidReminderTime({ hour: 24, minute: 0 })).toBe(false);
    expect(isValidReminderTime({ hour: 7, minute: 60 })).toBe(false);
    expect(isValidReminderTime({ hour: 7.5, minute: 0 })).toBe(false);
    expect(nextReminderOccurrences(NOW, { hour: 25, minute: 0 }, 3, fixedOffset(0))).toEqual([]);
  });

  it('schedules today when the time is still ahead, otherwise from tomorrow', () => {
    // 12:00 KST now: 19:30 today is ahead, 08:00 is tomorrow.
    const evening = nextReminderOccurrences(NOW, { hour: 19, minute: 30 }, 2, fixedOffset(KST));
    expect(evening.map((o) => o.atMs)).toEqual([NOW + 7.5 * 60 * MIN, NOW + 7.5 * 60 * MIN + DAY]);
    const morning = nextReminderOccurrences(NOW, { hour: 8, minute: 0 }, 1, fixedOffset(KST));
    expect(morning[0]?.atMs).toBe(NOW + 20 * 60 * MIN);
    // Exactly now is not "after now".
    const noon = nextReminderOccurrences(NOW, { hour: 12, minute: 0 }, 1, fixedOffset(KST));
    expect(noon[0]?.atMs).toBe(NOW + DAY);
  });

  it('property: occurrences are increasing, after now, one per day, at the local time', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: -720, max: 840 }),
        fc.integer({ min: 1, max: 10 }),
        (now, hour, minute, offset, count) => {
          const out = nextReminderOccurrences(now, { hour, minute }, count, fixedOffset(offset));
          expect(out).toHaveLength(count);
          let prev = now;
          for (const o of out) {
            expect(o.atMs).toBeGreaterThan(prev);
            expect(o.atMs - prev).toBeLessThanOrEqual(DAY);
            expect(localHourMinute(o.atMs, o.tzOffsetMinutes)).toEqual([hour, minute]);
            prev = o.atMs;
          }
        },
      ),
    );
  });

  it('property: honours a daylight-saving change between occurrences', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 1, max: 6 }),
        (hour, minute, switchDay) => {
          // Offset +60 until the switch instant, +120 afterwards (a spring-forward).
          const switchAt = NOW + switchDay * DAY;
          const tzAt = (ms: number) => (ms < switchAt ? 60 : 120);
          const out = nextReminderOccurrences(NOW, { hour, minute }, 8, tzAt);
          expect(out.length).toBeGreaterThanOrEqual(7);
          for (const o of out) {
            expect(o.tzOffsetMinutes).toBe(tzAt(o.atMs));
            const [h, m] = localHourMinute(o.atMs, o.tzOffsetMinutes);
            // Inside the skipped hour the wall clock lands one hour later; otherwise exact.
            expect(h === hour || h === (hour + 1) % 24).toBe(true);
            expect(m).toBe(minute);
          }
        },
      ),
    );
  });

  it('plans the study-queue due count at each reminder without changing state', () => {
    const world = sampleWorld();
    // 학교 graduated long ago: due again within the week.
    world.review(1, 3, NOW - 40 * DAY);
    world.review(1, 3, NOW - 40 * DAY + 10 * MIN);
    const state = replayAllEvents(world.events);
    const before = JSON.stringify([...state.cards.values()].map((c) => c.schedule));
    const occurrences = nextReminderOccurrences(NOW, { hour: 20, minute: 0 }, 7, fixedOffset(KST));
    const plan = planStudyReminders(state, occurrences);
    expect(plan).toHaveLength(7);
    for (const p of plan) {
      const expected = buildStudyQueue(state, {
        nowMs: p.atMs,
        tzOffsetMinutes: p.tzOffsetMinutes,
      }).counts.total;
      expect(p.dueCount).toBe(expected);
      expect(p.dueCount).toBeGreaterThan(0);
    }
    expect(JSON.stringify([...state.cards.values()].map((c) => c.schedule))).toBe(before);
    // Deterministic for the same input.
    expect(planStudyReminders(state, occurrences)).toEqual(plan);
  });
});

describe('Phase 13 search_notes core (Browse search rule)', () => {
  it('matches fields, ruby / cloze-stripped text, tag substrings and #tag categories', () => {
    const note = {
      id: 'n1',
      deck_id: 'd',
      created_order: 1,
      fields: { word: '日本[にほん]', meaning: 'The {{c1::capital}} city' },
      tags: ['Geo::Asia', 'JLPT-N5'],
      provenance: { source: 'manual' as const, reviewed: true },
      archived: false,
    } as unknown as Parameters<typeof noteMatchesSearchText>[0];
    expect(noteMatchesSearchText(note, '')).toBe(true);
    expect(noteMatchesSearchText(note, '  日本 ')).toBe(true);
    expect(noteMatchesSearchText(note, 'にほん')).toBe(true);
    expect(noteMatchesSearchText(note, 'capital city')).toBe(true);
    expect(noteMatchesSearchText(note, 'jlpt')).toBe(true);
    expect(noteMatchesSearchText(note, '#geo')).toBe(true);
    expect(noteMatchesSearchText(note, '#geo::asia')).toBe(true);
    expect(noteMatchesSearchText(note, '#asia')).toBe(false);
    expect(noteMatchesSearchText(note, '#')).toBe(false);
    expect(noteMatchesSearchText(note, 'paris')).toBe(false);
  });

  it('returns exactly the Browse notes for a filter, in creation order, with limit and total', () => {
    const state = sampleState();
    const filter = { deckIds: [KO_DECK] };
    const browseIds = filterBrowseNoteIds(state, filter, CTX);
    const all = searchNotes(state, filter, CTX);
    expect(new Set(all.notes.map((n) => n.id))).toEqual(browseIds);
    expect(all.total).toBe(browseIds.size);
    const orders = all.notes.map((n) => n.created_order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));

    const limited = searchNotes(state, filter, CTX, { limit: 2 });
    expect(limited.notes).toEqual(all.notes.slice(0, 2));
    expect(limited.total).toBe(all.total);

    const school = searchNotes(state, filter, CTX, { query: '학교' });
    expect(school.notes.map((n) => n.id)).toEqual([koNote(1)]);
  });

  it('ranks hardest-first when the filter asks for the hardest cards', () => {
    const world = sampleWorld();
    let t = NOW - 30 * DAY;
    world.review(2, 3, t);
    world.review(2, 3, (t += 10 * MIN));
    world.review(1, 3, t);
    world.review(1, 3, (t += 10 * MIN));
    for (let i = 0; i < 3; i++) {
      t += 2 * DAY;
      world.review(1, 1, t);
      world.review(1, 3, (t += 10 * MIN));
    }
    const state = replayAllEvents(world.events);
    const res = searchNotes(state, { deckIds: [KO_DECK], performance: { hardest: 2 } }, CTX);
    expect(res.notes.map((n) => n.id)).toEqual([koNote(1), koNote(2)]);
  });

  it('property: searching never returns a note Browse would hide, and limit only truncates', () => {
    const state = sampleState();
    const queries = ['', '학', '#', '#ko', 'a', 'school', '日', 'zzz'];
    fc.assert(
      fc.property(
        fc.constantFrom(...queries),
        fc.integer({ min: 0, max: 50 }),
        fc.boolean(),
        (query, limit, archived) => {
          const res = searchNotes(state, {}, CTX, { query, limit, archived });
          const browse = filterBrowseNoteIds(state, {}, CTX, { archived });
          for (const n of res.notes) {
            expect(browse.has(n.id)).toBe(true);
            expect(noteMatchesSearchText(n, query)).toBe(true);
          }
          expect(res.notes.length).toBe(Math.min(limit, res.total));
        },
      ),
    );
  });
});
