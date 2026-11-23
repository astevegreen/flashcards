import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEventFactory,
  isCardSuspended,
  replayAllEvents,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import { computeStatePatch, mergeStatePatch } from '../src/events/patch.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { FlashEvent, KnownEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId, FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import type { Card, ReviewRating } from '../src/model/types.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import {
  compareHardestCards,
  computeCardRetrievability,
  filterCardIds,
  filterCards,
  getCardStateKinds,
  isCardFilterEmpty,
  isLeechCard,
  LEECH_LAPSE_THRESHOLD,
  normalizeCardFilter,
  type CardFilter,
  type CardFilterContext,
} from '../src/study/filter.ts';
import {
  applyFilterPreset,
  BUILTIN_FILTER_PRESETS,
  filterNoteIds,
  listCategories,
} from '../src/study/filter-lists.ts';
import { buildStudyQueue } from '../src/study/queue.ts';

const DAY = 86_400_000;
const MIN = 60_000;
/** KST (+09:00). 2026-03-10 03:00 UTC = 12:00 local, well after the 04:00 rollover. */
const KST = 540;
const NOW = Date.UTC(2026, 2, 10, 3, 0, 0);
const CTX: CardFilterContext = { nowMs: NOW, tzOffsetMinutes: KST };

const KO_DECK = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
const JA_DECK = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ja-vocab');
const REC = 'layout:vocab-ko:recognition';
const PROD = 'layout:vocab-ko:production';
const koNote = (n: number) => deriveNoteId(KO_DECK, `ko-${n}`);
const koCard = (n: number, layout = REC) => deriveCardId(koNote(n), layout, 0);

interface Fixture {
  factory: EventFactory;
  events: KnownEvent[];
  review: (cardId: string, rating: ReviewRating, at: number) => void;
  state: () => CollectionState;
}

function makeFixture(): Fixture {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', SAMPLE_SEED_EPOCH_MS));
  const events: KnownEvent[] = buildSampleDeckEvents(factory);
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
    state: () => replayAllEvents(events),
  };
}

/**
 * Korean reference history (all before NOW):
 * - 학교 (ko-1): graduated, then 8 lapses -> leech
 * - 도서관 (ko-2): graduated, 1 lapse 3 days ago -> failed this week
 * - 약속 (ko-3): graduated 20 days ago, never failed (low retrievability now)
 * - 경험 (ko-4): new, never reviewed
 */
function koreanHistory(): Fixture {
  const fx = makeFixture();
  const start = NOW - 60 * DAY;
  // ko-1: Good, Good (graduate), then 8 x (Again, Good, Good) spread one day apart.
  let t = start;
  fx.review(koCard(1), 3, t);
  fx.review(koCard(1), 3, (t += 10 * MIN));
  for (let i = 0; i < LEECH_LAPSE_THRESHOLD; i++) {
    t += 3 * DAY;
    fx.review(koCard(1), 1, t);
    fx.review(koCard(1), 3, (t += 10 * MIN));
    fx.review(koCard(1), 3, (t += 10 * MIN));
  }
  // ko-2: graduate 30 days ago, lapse 3 days ago, relearn.
  fx.review(koCard(2), 3, NOW - 30 * DAY);
  fx.review(koCard(2), 3, NOW - 30 * DAY + 10 * MIN);
  fx.review(koCard(2), 1, NOW - 3 * DAY);
  fx.review(koCard(2), 3, NOW - 3 * DAY + 10 * MIN);
  // ko-3: graduate 20 days ago with Easy.
  fx.review(koCard(3), 4, NOW - 20 * DAY);
  return fx;
}

describe('Phase 9 filter model — normalization', () => {
  it('canonicalizes untrusted filters (golden)', () => {
    expect(
      normalizeCardFilter({
        deckIds: ['b', 'a', 'b', '', 7],
        categories: { mode: 'all', tags: [' TOPIK-1 ', 'hanja', 'hanja', ''] },
        states: ['leech', 'bogus', 'new'],
        performance: {
          minLapses: 2.7,
          failedWithinDays: 0,
          maxRetrievability: 1.5,
          hardest: 20,
          minAgainCount: -1,
        },
      }),
    ).toEqual({
      deckIds: ['a', 'b'],
      categories: { mode: 'all', tags: ['hanja', 'topik-1'] },
      states: ['new', 'leech'],
      performance: { minLapses: 2, hardest: 20 },
    });
    expect(normalizeCardFilter(null)).toEqual({});
    expect(normalizeCardFilter({ categories: { mode: 'weird', tags: ['a'] } })).toEqual({});
    expect(isCardFilterEmpty({})).toBe(true);
    expect(isCardFilterEmpty({ categories: { mode: 'any', tags: [] } })).toBe(true);
    expect(isCardFilterEmpty({ deckIds: [KO_DECK] })).toBe(false);
  });

  it('is idempotent', () => {
    const f = normalizeCardFilter({
      deckIds: [KO_DECK],
      categories: { mode: 'none', tags: ['Daily'] },
      performance: { failedWithinDays: 7 },
    });
    expect(normalizeCardFilter(f)).toEqual(f);
  });
});

describe('Phase 9 filter model — categories (Korean sample deck)', () => {
  const state = makeFixture().state();

  it('lists categories with note counts (golden)', () => {
    expect(listCategories(state, { deckIds: [KO_DECK] })).toEqual([
      { tag: 'daily', noteCount: 2 },
      { tag: 'hanja', noteCount: 3 },
      { tag: 'places', noteCount: 1 },
      { tag: 'topik-1', noteCount: 3 },
      { tag: 'topik-2', noteCount: 1 },
    ]);
  });

  const notesFor = (filter: CardFilter) =>
    [...filterNoteIds(state, normalizeCardFilter(filter), CTX)].sort();

  it('matches any / all / none (golden)', () => {
    const base = { deckIds: [KO_DECK] };
    expect(notesFor({ ...base, categories: { mode: 'any', tags: ['places', 'topik-2'] } })).toEqual(
      [koNote(2), koNote(4)].sort(),
    );
    expect(notesFor({ ...base, categories: { mode: 'all', tags: ['topik-1', 'hanja'] } })).toEqual(
      [koNote(1), koNote(2)].sort(),
    );
    expect(notesFor({ ...base, categories: { mode: 'none', tags: ['hanja'] } })).toEqual([
      koNote(3),
    ]);
  });

  it('spans decks and languages when no deck is chosen', () => {
    const ids = notesFor({ categories: { mode: 'any', tags: ['jlpt-n5', 'topik-2'] } });
    expect(ids).toContain(koNote(4));
    expect(ids).toContain(deriveNoteId(JA_DECK, 'ja-1'));
    expect(ids).not.toContain(koNote(1));
  });

  it('supports :: hierarchy prefix matching', () => {
    const fx = makeFixture();
    fx.events.push(
      fx.factory.create(
        'NoteUpserted',
        {
          note_id: koNote(1),
          deck_id: KO_DECK,
          source_key: 'ko-1',
          fields: {},
          tags: ['Grammar::Particles', 'topik-1'],
        },
        SAMPLE_SEED_EPOCH_MS + 1000,
      ),
    );
    const st = fx.state();
    const ids = [
      ...filterNoteIds(
        st,
        normalizeCardFilter({ categories: { mode: 'any', tags: ['grammar'] } }),
        CTX,
      ),
    ];
    expect(ids).toEqual([koNote(1)]);
    // `gram` is not a hierarchy parent of `grammar::particles`.
    expect(
      filterNoteIds(st, normalizeCardFilter({ categories: { mode: 'any', tags: ['gram'] } }), CTX)
        .size,
    ).toBe(0);
    expect(listCategories(st, { deckIds: [KO_DECK] }).map((c) => c.tag)).toContain('grammar');
  });

  it('treats NFD and NFC Hangul tags as one category (macOS input arrives as NFD)', () => {
    const fx = makeFixture();
    const nfc = '한국어';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    fx.events.push(
      fx.factory.create(
        'NoteUpserted',
        {
          note_id: koNote(1),
          deck_id: KO_DECK,
          source_key: 'ko-1',
          fields: {},
          tags: [nfd],
        },
        SAMPLE_SEED_EPOCH_MS + 1000,
      ),
      fx.factory.create(
        'NoteUpserted',
        {
          note_id: koNote(2),
          deck_id: KO_DECK,
          source_key: 'ko-2',
          fields: {},
          tags: [nfc],
        },
        SAMPLE_SEED_EPOCH_MS + 1000,
      ),
    );
    const st = fx.state();
    for (const wanted of [nfc, nfd]) {
      const ids = filterNoteIds(
        st,
        normalizeCardFilter({ categories: { mode: 'any', tags: [wanted] } }),
        CTX,
      );
      expect([...ids].sort()).toEqual([koNote(1), koNote(2)].sort());
    }
    const hangul = listCategories(st, { deckIds: [KO_DECK] }).filter(
      (c) => c.tag.normalize('NFC') === nfc,
    );
    expect(hangul).toHaveLength(1);
    expect(hangul[0]?.tag).toBe(nfc);
  });

  it('archived view filters archived notes by category only', () => {
    const fx = makeFixture();
    fx.events.push(fx.factory.create('NoteArchived', { note_id: koNote(3) }, NOW - DAY));
    const st = fx.state();
    const filter = normalizeCardFilter({ categories: { mode: 'any', tags: ['daily'] } });
    expect([...filterNoteIds(st, filter, CTX)]).not.toContain(koNote(3));
    expect([...filterNoteIds(st, filter, CTX, { archived: true })]).toEqual([koNote(3)]);
  });
});

describe('Phase 9 filter model — card state & performance (Korean history)', () => {
  const fx = koreanHistory();
  const state = fx.state();
  const card = (n: number): Card => {
    const c = state.cards.get(koCard(n));
    if (!c) throw new Error(`missing card ko-${n}`);
    return c;
  };
  const cardsFor = (filter: CardFilter) =>
    filterCards(state, normalizeCardFilter({ deckIds: [KO_DECK], ...filter }), CTX).map(
      (c) => c.id,
    );

  it('derives leech at 8 lapses without extra events', () => {
    expect(card(1).schedule.lapses).toBe(8);
    expect(isLeechCard(card(1))).toBe(true);
    expect(isLeechCard(card(2))).toBe(false);
    expect(getCardStateKinds(state, card(1), CTX).has('leech')).toBe(true);
    expect(cardsFor({ states: ['leech'] })).toEqual([koCard(1)]);
    // Virtual `leech` category.
    expect(cardsFor({ categories: { mode: 'any', tags: ['leech'] } })).toEqual([koCard(1)]);
    expect(cardsFor({ categories: { mode: 'none', tags: ['leech'] } })).toEqual(
      [koCard(2), koCard(3), koCard(4)].sort(),
    );
    // Configurable threshold.
    expect(getCardStateKinds(state, card(2), { ...CTX, leechThreshold: 1 }).has('leech')).toBe(
      true,
    );
  });

  it('classifies new / learning / review / due', () => {
    expect([...getCardStateKinds(state, card(4), CTX)]).toEqual(['new']);
    expect(getCardStateKinds(state, card(3), CTX).has('review')).toBe(true);
    expect(cardsFor({ states: ['new'] })).toEqual([koCard(4)]);
    // Easy 20 days ago on a fresh card: the interval has elapsed, so it is due today.
    expect(card(3).schedule.due).toBeLessThan(NOW);
    expect(cardsFor({ states: ['due'] })).toContain(koCard(3));
    expect(cardsFor({ states: ['due'] })).not.toContain(koCard(4));
  });

  it('lapses >= N and Again counts (golden)', () => {
    expect(cardsFor({ performance: { minLapses: 1 } })).toEqual([koCard(1), koCard(2)].sort());
    expect(cardsFor({ performance: { minLapses: 2 } })).toEqual([koCard(1)]);
    expect(cardsFor({ performance: { minAgainCount: 1 } })).toEqual([koCard(1), koCard(2)].sort());
  });

  it('failed within the last N study days (study-day aware boundary)', () => {
    // ko-2 lapsed 3 days ago; ko-1's last lapse was 36 days ago.
    expect(cardsFor({ performance: { failedWithinDays: 7 } })).toEqual([koCard(2)]);
    expect(cardsFor({ performance: { failedWithinDays: 3 } })).toEqual([]);
    expect(cardsFor({ performance: { failedWithinDays: 4 } })).toEqual([koCard(2)]);
    expect(cardsFor({ performance: { failedWithinDays: 60 } })).toEqual(
      [koCard(1), koCard(2)].sort(),
    );
  });

  it('ignores undone Again ratings', () => {
    const fx2 = koreanHistory();
    // rev ids are sequential; ko-2's lapse 3 days ago is review #(2 + 8*3 + 3) = 29.
    fx2.events.push(fx2.factory.create('ReviewUndone', { review_id: 'rev-0029' }, NOW - DAY));
    const st = fx2.state();
    expect(
      filterCards(
        st,
        normalizeCardFilter({ deckIds: [KO_DECK], performance: { failedWithinDays: 7 } }),
        CTX,
      ),
    ).toEqual([]);
  });

  it('computes FSRS retrievability (0.9 at t = S, decreasing, undefined for new)', () => {
    const c3 = card(3);
    const lastReview = c3.schedule.last_review ?? 0;
    const atS = computeCardRetrievability(state, c3, lastReview + c3.schedule.stability * DAY);
    expect(atS).toBeCloseTo(0.9, 10);
    const now = computeCardRetrievability(state, c3, NOW) ?? 1;
    const later = computeCardRetrievability(state, c3, NOW + 30 * DAY) ?? 1;
    expect(later).toBeLessThan(now);
    expect(computeCardRetrievability(state, card(4), NOW)).toBeUndefined();
    const low = cardsFor({ performance: { maxRetrievability: now + 1e-9 } });
    expect(low).toContain(koCard(3));
    expect(low).not.toContain(koCard(4));
  });

  it('ranks hardest N exactly like MCP get_weak_cards', () => {
    const all = cardsFor({ performance: { hardest: 10 } });
    // MCP ordering, reproduced verbatim from tools/cli/src/mcp.ts.
    const mcp = [...state.cards.values()]
      .filter((c) => c.deck_id === KO_DECK)
      .filter((c) => !(c.schedule.reps === 0 && c.schedule.lapses === 0))
      .map((c) => ({
        cardId: c.id,
        lapses: c.schedule.lapses,
        stability: Number(c.schedule.stability.toFixed(4)),
        difficulty: Number(c.schedule.difficulty.toFixed(4)),
      }))
      .sort(
        (a, b) =>
          b.lapses - a.lapses ||
          a.stability - b.stability ||
          b.difficulty - a.difficulty ||
          (a.cardId < b.cardId ? -1 : 1),
      )
      .map((c) => c.cardId);
    expect(all).toEqual(mcp);
    expect(all[0]).toBe(koCard(1));
    expect(all).not.toContain(koCard(4));
    expect(cardsFor({ performance: { hardest: 1 } })).toEqual([koCard(1)]);
    expect([card(2), card(1)].sort(compareHardestCards).map((c) => c.id)).toEqual([
      koCard(1),
      koCard(2),
    ]);
  });

  it('presets: Trouble cards and Failed this week (golden)', () => {
    expect(BUILTIN_FILTER_PRESETS.map((p) => p.id)).toEqual(['trouble-cards', 'failed-this-week']);
    const trouble = applyFilterPreset(
      { deckIds: [KO_DECK], categories: { mode: 'any', tags: ['topik-1'] } },
      'trouble-cards',
    );
    expect(trouble).toEqual({
      deckIds: [KO_DECK],
      categories: { mode: 'any', tags: ['topik-1'] },
      performance: { minAgainCount: 1, hardest: 50 },
    });
    expect(filterCards(state, trouble, CTX).map((c) => c.id)).toEqual([koCard(1), koCard(2)]);
    const week = applyFilterPreset({ deckIds: [KO_DECK] }, 'failed-this-week');
    expect([...filterCardIds(state, week, CTX)]).toEqual([koCard(2)]);
  });

  it('is deterministic regardless of event delivery order', () => {
    const reversed = applyEvents(replayAllEvents([]), [...fx.events].reverse());
    const filter = applyFilterPreset({ deckIds: [KO_DECK] }, 'trouble-cards');
    expect(filterCards(reversed, filter, CTX).map((c) => c.id)).toEqual(
      filterCards(state, filter, CTX).map((c) => c.id),
    );
  });
});

function suspend(fx: Fixture, cardId: string, at: number, on = true): void {
  fx.events.push(
    fx.factory.create(on ? 'CardSuspended' : 'CardUnsuspended', { card_id: cardId }, at),
  );
}

describe('Phase 9 CardSuspended / CardUnsuspended', () => {
  it('suspends and unsuspends with last-writer-wins by HLC', () => {
    const fx = makeFixture();
    suspend(fx, koCard(1), NOW - 3 * DAY);
    expect(isCardSuspended(fx.state(), koCard(1))).toBe(true);
    suspend(fx, koCard(1), NOW - 2 * DAY, false);
    expect(isCardSuspended(fx.state(), koCard(1))).toBe(false);
    suspend(fx, koCard(1), NOW - DAY);
    const st = fx.state();
    expect(isCardSuspended(st, koCard(1))).toBe(true);
    expect(getCardStateKinds(st, st.cards.get(koCard(1)) as Card, CTX).has('suspended')).toBe(true);
  });

  it('excludes suspended cards from the queue, keeps them filterable, survives note edits', () => {
    const fx = makeFixture();
    suspend(fx, koCard(2), NOW - DAY);
    fx.events.push(
      fx.factory.create(
        'NoteUpserted',
        { note_id: koNote(2), deck_id: KO_DECK, source_key: 'ko-2', fields: { notes: 'edited' } },
        NOW - DAY + 1000,
      ),
    );
    const st = fx.state();
    const queue = buildStudyQueue(st, { deckId: KO_DECK, nowMs: NOW, tzOffsetMinutes: KST });
    expect(queue.queue.map((c) => c.id)).not.toContain(koCard(2));
    expect(queue.counts.new).toBe(3);
    expect([...filterCardIds(st, { states: ['suspended'] }, CTX)]).toEqual([koCard(2)]);
    expect(
      filterCardIds(st, { states: ['suspended'] }, { ...CTX, excludeSuspended: true }).size,
    ).toBe(0);
  });

  it('ignores malformed payloads without throwing', () => {
    const fx = makeFixture();
    const bad = fx.factory.create('CardSuspended', { card_id: koCard(1) }, NOW) as FlashEvent;
    const malformed = { ...bad, payload: { card_id: 42 } } as unknown as FlashEvent;
    const st = replayAllEvents([...fx.events, malformed]);
    expect(isCardSuspended(st, koCard(1))).toBe(false);
  });

  it('round-trips through snapshots and Worker patches', () => {
    const fx = makeFixture();
    suspend(fx, koCard(3), NOW - DAY);
    const st = fx.state();
    const restored = deserializeCollectionState(
      JSON.parse(JSON.stringify(serializeCollectionState(st))) as ReturnType<
        typeof serializeCollectionState
      >,
    );
    expect(isCardSuspended(restored, koCard(3))).toBe(true);

    const worker = replayAllEvents(fx.events.slice(0, -1));
    const main = replayAllEvents(fx.events.slice(0, -1));
    const last = fx.events[fx.events.length - 1] as KnownEvent;
    mergeStatePatch(main, computeStatePatch(worker, [last]));
    expect(isCardSuspended(main, koCard(3))).toBe(true);
  });

  it('upgrades snapshots written by builds that kept suspension events as unknown', () => {
    const fx = makeFixture();
    const base = fx.state();
    const s1 = fx.factory.create('CardSuspended', { card_id: koCard(1) }, NOW - 2 * DAY);
    const s2 = fx.factory.create('CardSuspended', { card_id: koCard(4) }, NOW - 2 * DAY);
    const u2 = fx.factory.create('CardUnsuspended', { card_id: koCard(4) }, NOW - DAY);
    const future = {
      id: 'future-1',
      device: 'dev-z',
      seq: 1,
      hlc: s1.hlc,
      type: 'SomethingFromTheFuture',
      v: 3,
      payload: { x: 1 },
    };
    // What an older build would have serialized: the new events sit in `unknownEvents`.
    const oldSnapshot = serializeCollectionState(base, { 'dev-a': u2.seq });
    oldSnapshot.unknownEvents = [s1, s2, u2, future].map((e) => JSON.parse(JSON.stringify(e)));

    const upgraded = deserializeCollectionState(oldSnapshot);
    expect(isCardSuspended(upgraded, koCard(1))).toBe(true);
    expect(isCardSuspended(upgraded, koCard(4))).toBe(false);
    expect(upgraded.unknownEvents.map((e) => e.type)).toEqual(['SomethingFromTheFuture']);
    // Same answer as a full replay on a current build.
    const full = replayAllEvents([...fx.events, s1, s2, u2]);
    for (const n of [1, 2, 3, 4]) {
      expect(isCardSuspended(upgraded, koCard(n))).toBe(isCardSuspended(full, koCard(n)));
    }
  });
});

describe('Phase 9 filtered buildStudyQueue', () => {
  it('returns the identical queue for no filter and an empty filter', () => {
    const st = koreanHistory().state();
    const opts = { nowMs: NOW, tzOffsetMinutes: KST };
    const a = buildStudyQueue(st, opts);
    const b = buildStudyQueue(st, { ...opts, filter: {} });
    expect(b.queue.map((c) => c.id)).toEqual(a.queue.map((c) => c.id));
    expect(b.counts).toEqual(a.counts);
  });

  it('restricts to matching cards with the same schedule', () => {
    const st = koreanHistory().state();
    const opts = { nowMs: NOW, tzOffsetMinutes: KST };
    const unfiltered = buildStudyQueue(st, { ...opts, deckId: KO_DECK });
    const filtered = buildStudyQueue(st, {
      ...opts,
      filter: { deckIds: [KO_DECK], categories: { mode: 'none', tags: ['topik-2'] } },
    });
    const ids = filtered.queue.map((c) => c.id);
    expect(ids).not.toContain(koCard(4));
    // Every queued card is the same object (same FSRS state) as in the unfiltered queue.
    for (const c of filtered.queue) {
      expect(unfiltered.queue.find((u) => u.id === c.id)).toBe(c);
    }
    // Relative order is preserved.
    expect(ids).toEqual(unfiltered.queue.map((c) => c.id).filter((id) => ids.includes(id)));
  });

  it('only studies due cards of a preset (schedule mode)', () => {
    const fx = makeFixture();
    fx.review(koCard(1), 1, NOW - 5 * MIN); // failed 5 minutes ago -> learning, due soon
    const st = fx.state();
    const filter = applyFilterPreset({ deckIds: [KO_DECK] }, 'failed-this-week');
    const before = buildStudyQueue(st, { nowMs: NOW, tzOffsetMinutes: KST, filter });
    expect(before.counts.new).toBe(0);
    const later = NOW + 30 * MIN;
    const after = buildStudyQueue(st, { nowMs: later, tzOffsetMinutes: KST, filter });
    expect(after.queue.map((c) => c.id)).toEqual([koCard(1)]);
    expect(after.counts).toEqual({ new: 0, learning: 1, due: 0, total: 1 });
  });

  it('keeps sibling burying under a filter', () => {
    const fx = makeFixture();
    fx.events.push(
      fx.factory.create(
        'DeckSettingsChanged',
        { deck_id: KO_DECK, settings: { enabled_layout_ids: [REC, PROD] } },
        SAMPLE_SEED_EPOCH_MS + 5000,
      ),
    );
    fx.review(koCard(1), 3, NOW - 60 * MIN);
    const st = fx.state();
    const q = buildStudyQueue(st, {
      nowMs: NOW,
      tzOffsetMinutes: KST,
      filter: { deckIds: [KO_DECK], categories: { mode: 'any', tags: ['daily'] } },
    });
    const ids = q.queue.map((c) => c.id);
    // ko-1's production sibling is buried because its recognition card was reviewed today.
    expect(ids).not.toContain(koCard(1, PROD));
    expect(q.buriedNoteIds.has(koNote(1))).toBe(true);
    // At most one card per note.
    const notes = q.queue.map((c) => c.note_id);
    expect(new Set(notes).size).toBe(notes.length);
    expect(notes).toContain(koNote(3));
  });

  it('respects daily new-card limits under a filter', () => {
    const fx = makeFixture();
    fx.events.push(
      fx.factory.create(
        'DeckSettingsChanged',
        { deck_id: KO_DECK, settings: { new_cards_per_day: 1 } },
        SAMPLE_SEED_EPOCH_MS + 5000,
      ),
    );
    const q = buildStudyQueue(fx.state(), {
      nowMs: NOW,
      tzOffsetMinutes: KST,
      filter: { categories: { mode: 'any', tags: ['hanja'] } },
    });
    expect(q.queue.filter((c) => c.deck_id === KO_DECK)).toHaveLength(1);
  });
});
