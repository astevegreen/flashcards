import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  replayAllEvents,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import type { KnownEvent } from '../src/events/types.ts';
import { compareHlc, createHlcState } from '../src/hlc.ts';
import { decodeUtf8 } from '../src/utf8-decode.ts';
import { deriveCardId, deriveNoteId, FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import type { ReviewRating } from '../src/model/types.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import { computeCollectionStats, computeFilteredCollectionStats } from '../src/stats/index.ts';
import {
  buildReviewAheadQueue,
  buildStudySetSavedPayload,
  cardFilterToStatsFilter,
  listStudySets,
} from '../src/study/custom-study.ts';
import {
  filterCards,
  LEECH_LAPSE_THRESHOLD,
  normalizeCardFilter,
  planLeechTag,
  planLeechTagUndo,
  rankHardestCards,
  splitHardestCriterion,
  type CardFilter,
} from '../src/study/filter.ts';
import { filterNoteIds } from '../src/study/filter-lists.ts';
import { buildStudyQueue, compareCodeUnits } from '../src/study/queue.ts';
import { planStudySetTagRewrites, rewriteStudySetFilter } from '../src/study/study-set-tags.ts';
import { resolveTagOperation, type TagOperation } from '../src/tags/index.ts';

const DAY = 86_400_000;
const MIN = 60_000;
const KST = 540;
const NOW = Date.UTC(2026, 2, 10, 3, 0, 0);
const KO_DECK = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
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

/** Graduates a card, then gives it `lapses` lapses (Again, Good, Good each), ending at `end`. */
function lapseCard(fx: Fixture, cardId: string, lapses: number, end: number): void {
  let t = end - (lapses + 1) * 3 * DAY;
  fx.review(cardId, 3, t);
  fx.review(cardId, 3, (t += 10 * MIN));
  for (let i = 0; i < lapses; i++) {
    t += 3 * DAY;
    fx.review(cardId, 1, t);
    fx.review(cardId, 3, (t += 10 * MIN));
    fx.review(cardId, 3, (t += 10 * MIN));
  }
}

function saveSet(fx: Fixture, setId: string, filter: CardFilter, name = setId): void {
  const payload = buildStudySetSavedPayload({ setId, name, filter });
  if (payload) fx.events.push(fx.factory.create('StudySetSaved', payload, NOW - DAY));
}

/** Applies a tag manager operation the way the UI does: note tags and Study Sets in one batch. */
function runTagOperation(fx: Fixture, op: TagOperation, at = NOW): void {
  const st = fx.state();
  const sets = planStudySetTagRewrites(st, op);
  for (const p of sets) fx.events.push(fx.factory.create('StudySetSaved', p, at));
}

const setFilter = (st: CollectionState, id: string) =>
  listStudySets(st).find((s) => s.id === id)?.filter;

describe('Phase 9 completion — Study Sets follow category rename / merge / delete', () => {
  const resolved = (op: Exclude<TagOperation, { kind: 'normalize' }>) => {
    const r = resolveTagOperation(op);
    if ('error' in r) throw new Error(r.error.code);
    return r;
  };

  it('renames a category and its :: children inside a set filter (golden)', () => {
    const filter = normalizeCardFilter({
      deckIds: [KO_DECK],
      categories: { mode: 'all', tags: ['grammar::particles', 'hanja'] },
      states: ['due'],
    });
    expect(
      rewriteStudySetFilter(filter, resolved({ kind: 'rename', from: 'Grammar', to: '문법' })),
    ).toEqual({
      deckIds: [KO_DECK],
      categories: { mode: 'all', tags: ['hanja', '문법::particles'] },
      states: ['due'],
    });
    // Untouched filters report no change.
    expect(
      rewriteStudySetFilter(filter, resolved({ kind: 'rename', from: 'daily', to: 'x' })),
    ).toBeUndefined();
    expect(
      rewriteStudySetFilter({ deckIds: ['d'] }, resolved({ kind: 'delete', tags: ['hanja'] })),
    ).toBeUndefined();
  });

  it('merges several categories into one', () => {
    const filter = normalizeCardFilter({ categories: { mode: 'any', tags: ['daily', 'places'] } });
    expect(
      rewriteStudySetFilter(
        filter,
        resolved({ kind: 'merge', from: ['daily', 'places'], into: 'Everyday' }),
      ),
    ).toEqual({ categories: { mode: 'any', tags: ['everyday'] } });
  });

  it('deletes a category only where that cannot widen the set', () => {
    const del = resolved({ kind: 'delete', tags: ['places'] });
    const crit = (mode: 'any' | 'all' | 'none', tags: string[]) =>
      normalizeCardFilter({ categories: { mode, tags } });
    expect(rewriteStudySetFilter(crit('none', ['places']), del)).toEqual({});
    expect(rewriteStudySetFilter(crit('none', ['daily', 'places']), del)).toEqual(
      crit('none', ['daily']),
    );
    expect(rewriteStudySetFilter(crit('any', ['daily', 'places']), del)).toEqual(
      crit('any', ['daily']),
    );
    // Dropping the last `any` category, or any `all` category, would widen the selection.
    expect(rewriteStudySetFilter(crit('any', ['places']), del)).toBeUndefined();
    expect(rewriteStudySetFilter(crit('all', ['daily', 'places']), del)).toBeUndefined();
  });

  it('plans filter-only StudySetSaved events, skips refused operations and is idempotent', () => {
    const fx = makeFixture();
    saveSet(fx, 'set-hanja', normalizeCardFilter({ categories: { mode: 'any', tags: ['hanja'] } }));
    saveSet(fx, 'set-deck', normalizeCardFilter({ deckIds: [KO_DECK] }));
    const before = fx.state();
    const op: TagOperation = { kind: 'rename', from: 'hanja', to: '한자' };
    const payloads = planStudySetTagRewrites(before, op);
    expect(payloads).toEqual([
      {
        set_id: 'set-hanja',
        filter: { categories: { mode: 'any', tags: ['한자'] } },
        tag_rewrite: true,
      },
    ]);
    // Refused (target inside the source subtree) and normalize plan nothing.
    expect(
      planStudySetTagRewrites(before, { kind: 'rename', from: 'hanja', to: 'hanja::x' }),
    ).toEqual([]);
    expect(planStudySetTagRewrites(before, { kind: 'normalize' })).toEqual([]);

    runTagOperation(fx, op);
    const after = fx.state();
    expect(setFilter(after, 'set-hanja')).toEqual({
      categories: { mode: 'any', tags: ['한자'] },
    });
    expect(listStudySets(after).find((s) => s.id === 'set-hanja')?.name).toBe('set-hanja');
    expect(planStudySetTagRewrites(after, op)).toEqual([]);
  });

  it('a concurrent rename of the set on another device survives the category rewrite', () => {
    const fx = makeFixture();
    saveSet(fx, 'set-1', normalizeCardFilter({ categories: { mode: 'any', tags: ['daily'] } }));
    const other = createEventFactory('dev-b', 0, createHlcState('dev-b', NOW));
    const rename = other.create('StudySetSaved', { set_id: 'set-1', name: 'Every day' }, NOW + 5);
    runTagOperation(fx, { kind: 'rename', from: 'daily', to: 'everyday' }, NOW + 1);
    for (const order of [
      [...fx.events, rename],
      [rename, ...[...fx.events].reverse()],
    ]) {
      const [set] = listStudySets(replayAllEvents(order));
      expect(set).toEqual({
        id: 'set-1',
        name: 'Every day',
        filter: { categories: { mode: 'any', tags: ['everyday'] } },
        mode: 'schedule',
      });
    }
  });
});

describe('Phase 9 completion — category rewrite vs concurrent Study Set delete', () => {
  it('a set deleted on another device stays deleted after a later category rename', () => {
    const fx = makeFixture();
    saveSet(fx, 'set-1', normalizeCardFilter({ categories: { mode: 'any', tags: ['grammar'] } }));
    // Device B deletes the set; device A has not synced and renames #grammar a moment later.
    const other = createEventFactory('dev-b', 0, createHlcState('dev-b', NOW));
    const deleted = other.create('StudySetDeleted', { set_id: 'set-1' }, NOW + 10);
    runTagOperation(fx, { kind: 'rename', from: 'grammar', to: '문법' }, NOW + 11);
    const rewrite = fx.events.at(-1);
    expect(rewrite?.type).toBe('StudySetSaved');
    expect(compareHlc(rewrite?.hlc ?? '', deleted.hlc)).toBeGreaterThan(0);
    for (const order of [
      [...fx.events, deleted],
      [deleted, ...[...fx.events].reverse()],
    ]) {
      expect(listStudySets(replayAllEvents(order))).toEqual([]);
    }
  });

  it('a user save after the delete brings the set back with the rewritten filter', () => {
    const fx = makeFixture();
    saveSet(fx, 'set-1', normalizeCardFilter({ categories: { mode: 'any', tags: ['grammar'] } }));
    const other = createEventFactory('dev-b', 0, createHlcState('dev-b', NOW));
    const deleted = other.create('StudySetDeleted', { set_id: 'set-1' }, NOW + 10);
    runTagOperation(fx, { kind: 'rename', from: 'grammar', to: '문법' }, NOW + 11);
    const restore = other.create('StudySetSaved', { set_id: 'set-1', name: 'Grammar' }, NOW + 20);
    const [set] = listStudySets(replayAllEvents([...fx.events, deleted, restore]));
    expect(set).toEqual({
      id: 'set-1',
      name: 'Grammar',
      filter: { categories: { mode: 'any', tags: ['문법'] } },
      mode: 'schedule',
    });
  });
});

describe('Phase 9 completion — leech tag', () => {
  it('tags the note leech at the threshold, once, and keeps its other tags', () => {
    const fx = makeFixture();
    lapseCard(fx, koCard(1), LEECH_LAPSE_THRESHOLD - 1, NOW - DAY);
    const st = fx.state();
    const card = st.cards.get(koCard(1));
    if (!card) throw new Error('missing card');
    expect(card.schedule.lapses).toBe(LEECH_LAPSE_THRESHOLD - 1);
    const payload = planLeechTag(st, card, 7, 8);
    // A set-union add (`NoteTagsAdded`), so a concurrent tag edit elsewhere is never overwritten.
    expect(payload).toEqual({ note_id: koNote(1), tags: ['leech'], reason: 'leech' });
    // Only the review that crosses the threshold tags.
    expect(planLeechTag(st, card, 6, 7)).toBeUndefined();
    expect(planLeechTag(st, card, 8, 9)).toBeUndefined();

    if (!payload) throw new Error('no payload');
    fx.events.push(fx.factory.create('NoteTagsAdded', payload, NOW));
    const tagged = fx.state();
    expect(tagged.notes.get(koNote(1))?.tags).toEqual(['topik-1', 'hanja', 'daily', 'leech']);
    // Already tagged (any spelling): nothing more to do.
    expect(planLeechTag(tagged, card, 7, 8)).toBeUndefined();
    // The category is a real note tag now: every card of the note matches `leech`.
    const ids = filterNoteIds(
      tagged,
      { categories: { mode: 'any', tags: ['leech'] } },
      { nowMs: NOW, tzOffsetMinutes: KST },
    );
    expect([...ids]).toEqual([koNote(1)]);
  });

  it('undo removes the tag unless another card of the note is still a leech', () => {
    const fx = makeFixture();
    lapseCard(fx, koCard(1), LEECH_LAPSE_THRESHOLD, NOW - DAY);
    const st = fx.state();
    const card = st.cards.get(koCard(1));
    if (!card) throw new Error('missing card');
    const tag = planLeechTag(st, card, 7, 8);
    if (!tag) throw new Error('no tag');
    fx.events.push(fx.factory.create('NoteTagsAdded', tag, NOW));
    const tagged = fx.state();
    const untag = planLeechTagUndo(tagged, card);
    expect(untag?.tags).toEqual(['topik-1', 'hanja', 'daily']);
    // The undo rewrites the tag list after the add, so the tag really goes away on replay.
    if (!untag) throw new Error('no untag');
    fx.events.push(fx.factory.create('NoteUpserted', untag, NOW + MIN));
    expect(fx.state().notes.get(koNote(1))?.tags).toEqual(['topik-1', 'hanja', 'daily']);

    // Another card of the note (a production card) is a leech too: the tag stays.
    const sibling = { ...card, id: koCard(1, PROD), layout_id: PROD };
    tagged.cards.set(sibling.id, sibling);
    tagged.cardIdsByNote.get(koNote(1))?.add(sibling.id);
    expect(planLeechTagUndo(tagged, card)).toBeUndefined();
  });
});

describe('Phase 9 completion — hardest N is ranked after the due check', () => {
  /**
   * ko-1: 5 lapses, reviewed yesterday (due in 3 days). ko-2: 2 lapses, due. ko-3: 1 lapse, due.
   * Nothing is reviewed today yet.
   */
  function hardestFixtureEvents(): Fixture {
    const fx = makeFixture();
    lapseCard(fx, koCard(1), 5, NOW - 40 * DAY);
    fx.review(koCard(1), 4, NOW - DAY);
    fx.review(koCard(1), 4, NOW - DAY + 10 * MIN);
    lapseCard(fx, koCard(2), 2, NOW - 40 * DAY);
    lapseCard(fx, koCard(3), 1, NOW - 40 * DAY);
    return fx;
  }
  const hardestFixture = () => hardestFixtureEvents().state();
  const scope = { nowMs: NOW, tzOffsetMinutes: KST };

  it('splits the cap off the filter', () => {
    expect(splitHardestCriterion({ performance: { hardest: 3 } })).toEqual({
      base: {},
      hardest: 3,
    });
    expect(
      splitHardestCriterion({ deckIds: ['d'], performance: { minLapses: 2, hardest: 3 } }),
    ).toEqual({ base: { deckIds: ['d'], performance: { minLapses: 2 } }, hardest: 3 });
    expect(splitHardestCriterion({ deckIds: ['d'] })).toEqual({
      base: { deckIds: ['d'] },
      hardest: undefined,
    });
  });

  it('on schedule, the N hardest due cards are queued (not the overall N hardest)', () => {
    const st = hardestFixture();
    const filter = normalizeCardFilter({ deckIds: [KO_DECK], performance: { hardest: 1 } });
    // Overall the hardest card is ko-1, which is not due.
    expect(filterCards(st, filter, scope).map((c) => c.id)).toEqual([koCard(1)]);
    const q = buildStudyQueue(st, { ...scope, filter });
    expect(q.queue.map((c) => c.id)).toEqual([koCard(2)]);
    const due = buildStudyQueue(st, { ...scope, filter: { deckIds: [KO_DECK] } }).queue.filter(
      (c) => c.schedule.reps > 0,
    );
    expect(q.queue).toEqual(rankHardestCards(due, 1));
    // New cards never rank.
    expect(q.counts.new).toBe(0);
    const two = buildStudyQueue(st, {
      ...scope,
      filter: { ...filter, performance: { hardest: 2 } },
    });
    expect(two.queue.map((c) => c.id).sort(compareCodeUnits)).toEqual(
      [koCard(2), koCard(3)].sort(compareCodeUnits),
    );
  });

  it('review ahead ranks the cards inside its window', () => {
    const st = hardestFixture();
    expect((st.cards.get(koCard(1))?.schedule.due ?? 0) - NOW).toBeGreaterThan(2 * DAY);
    const filter = normalizeCardFilter({ deckIds: [KO_DECK], performance: { hardest: 1 } });
    const ahead = buildReviewAheadQueue(st, { ...scope, days: 1, filter });
    expect(ahead.queue.map((c) => c.id)).toEqual([koCard(2)]);
  });

  it('answering a card does not free a slot for the next hardest due card', () => {
    const filter = normalizeCardFilter({ deckIds: [KO_DECK], performance: { hardest: 1 } });
    const fx = hardestFixtureEvents();
    fx.review(koCard(2), 3, NOW);
    const later = { ...scope, nowMs: NOW + MIN };
    // ko-2 used today's one slot; ko-3 (still due) is not promoted.
    expect(buildStudyQueue(fx.state(), { ...later, filter }).queue).toEqual([]);
    expect(buildReviewAheadQueue(fx.state(), { ...later, days: 1, filter }).queue).toEqual([]);
    // With two slots, ko-3 takes the second one.
    const two = { ...filter, performance: { hardest: 2 } };
    expect(buildStudyQueue(fx.state(), { ...later, filter: two }).queue.map((c) => c.id)).toEqual([
      koCard(3),
    ]);
    // The cap resets on the next study day.
    const tomorrow = buildStudyQueue(fx.state(), { ...scope, nowMs: NOW + DAY, filter });
    expect(tomorrow.queue.map((c) => c.id)).toEqual([koCard(3)]);
  });

  it('a card failed in the session stays queued in its slot', () => {
    const filter = normalizeCardFilter({ deckIds: [KO_DECK], performance: { hardest: 1 } });
    const fx = hardestFixtureEvents();
    fx.review(koCard(2), 1, NOW);
    const st = fx.state();
    const relearnDue = st.cards.get(koCard(2))?.schedule.due ?? 0;
    const q = buildStudyQueue(st, { ...scope, nowMs: relearnDue + MIN, filter });
    expect(q.queue.map((c) => c.id)).toEqual([koCard(2)]);
  });
});

describe('Phase 9 completion — Stats filter and category export', () => {
  function reviewedState(): CollectionState {
    const fx = makeFixture();
    lapseCard(fx, koCard(1), 2, NOW - 2 * DAY);
    lapseCard(fx, koCard(3), 1, NOW - DAY);
    fx.review(koCard(2), 3, NOW - 3 * DAY);
    return fx.state();
  }
  const options = { nowMs: NOW, tzOffsetMinutes: KST };

  it('computeFilteredCollectionStats is the core stats for the compiled CardFilter', () => {
    const st = reviewedState();
    expect(computeFilteredCollectionStats(st, {}, options)).toEqual(
      computeCollectionStats(st, options),
    );
    const filter = { deckIds: [KO_DECK], categories: { mode: 'any', tags: ['places'] } };
    const filtered = computeFilteredCollectionStats(st, filter, options);
    expect(filtered).toEqual(
      computeCollectionStats(st, {
        ...options,
        filter: cardFilterToStatsFilter(st, filter, options),
      }),
    );
    // #places is only ko-2 (one card, one review).
    expect(filtered.totals.cards).toBe(1);
    expect(filtered.totals.reviews).toBe(1);
  });

  it('exports one category as a .flashpkg with only its notes, categories kept', () => {
    const st = reviewedState();
    const noteIds = filterNoteIds(
      st,
      { categories: { mode: 'any', tags: ['daily'] } },
      { nowMs: NOW, tzOffsetMinutes: KST },
    );
    expect([...noteIds].sort(compareCodeUnits)).toEqual(
      [koNote(1), koNote(3)].sort(compareCodeUnits),
    );
    const bytes = exportFlashpkg(st, { noteIds, name: '#daily' });
    const files = unzipSync(bytes);
    const manifest = JSON.parse(decodeUtf8(files['manifest.json'] ?? new Uint8Array())) as {
      package_id: string;
      name: string;
      decks: Array<{ id: string }>;
      subset?: boolean;
    };
    expect(manifest.package_id.startsWith('pkg:notes-')).toBe(true);
    expect(manifest.subset).toBe(true);
    expect(manifest.name).toBe('#daily');
    expect(manifest.decks.map((d) => d.id)).toEqual([KO_DECK]);
    expect(Object.keys(files).some((f) => f.startsWith('pages/'))).toBe(false);

    const target = createEmptyState();
    const f = createEventFactory('dev-z', 0, createHlcState('dev-z', NOW));
    const imported = importFlashpkg(bytes, target, f, { nowMs: NOW });
    applyEvents(target, imported.events);
    const tags = [...target.notes.values()].map((n) => n.tags);
    expect(tags).toEqual([
      ['topik-1', 'hanja', 'daily'],
      ['topik-1', 'daily'],
    ]);
    // Narrowed to a deck without the category: nothing to export.
    const ja = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ja-vocab');
    const empty = unzipSync(exportFlashpkg(st, { noteIds, deckId: ja }));
    expect(
      (JSON.parse(decodeUtf8(empty['manifest.json'] ?? new Uint8Array())) as { decks: [] }).decks,
    ).toEqual([]);
  });

  it('re-importing a category package into its own deck never archives the other notes', () => {
    const st = reviewedState();
    const noteIds = filterNoteIds(
      st,
      { categories: { mode: 'any', tags: ['daily'] } },
      { nowMs: NOW, tzOffsetMinutes: KST },
    );
    const bytes = exportFlashpkg(st, { noteIds, name: '#daily' });
    const before = st.decks.get(KO_DECK);
    const activeBefore = [...st.notes.values()].filter((n) => !n.archived).length;
    const f = createEventFactory('dev-z', 0, createHlcState('dev-z', NOW));
    // As a watched folder or package URL re-imports it.
    const imported = importFlashpkg(bytes, st, f, { nowMs: NOW, archiveRemovedOnUpgrade: true });
    expect(imported.events.filter((e) => e.type === 'NoteArchived')).toEqual([]);
    expect(imported.events.filter((e) => e.type === 'SourceLinked')).toEqual([]);
    applyEvents(st, imported.events);
    expect([...st.notes.values()].filter((n) => !n.archived)).toHaveLength(activeBefore);
    expect(st.decks.get(KO_DECK)?.name).toBe(before?.name);
    expect(st.decks.get(KO_DECK)?.source).toEqual(before?.source);

    // A full deck export still archives notes missing from a newer version.
    const full = exportFlashpkg(st, { deckId: KO_DECK });
    const manifest = JSON.parse(decodeUtf8(unzipSync(full)['manifest.json'] ?? new Uint8Array()));
    expect((manifest as { subset?: boolean }).subset).toBeUndefined();
  });
});
