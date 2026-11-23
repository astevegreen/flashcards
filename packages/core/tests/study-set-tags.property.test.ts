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
import { deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import { listStudySets } from '../src/study/custom-study.ts';
import { normalizeCardFilter, type CardFilter } from '../src/study/filter.ts';
import { filterNoteIds } from '../src/study/filter-lists.ts';
import { compareCodeUnits } from '../src/study/queue.ts';
import { planStudySetTagRewrites, rewriteStudySetFilter } from '../src/study/study-set-tags.ts';
import { planTagOperation, resolveTagOperation, type TagOperation } from '../src/tags/index.ts';

const DECK = 'deck-ko-study-set-tags-prop';
const KST = 540;
const POOL = ['grammar', 'grammar::verbs', 'grammar::particles', 'hanja', 'daily', 'places'];
const TOP = ['grammar', 'hanja', 'daily', 'places'];
const NOTE_TAGS: string[][] = [
  ['grammar::verbs', 'daily'],
  ['grammar::particles'],
  ['hanja', 'places'],
  ['hanja', 'daily'],
  ['grammar', 'hanja'],
  [],
];
const MODES = ['any', 'all', 'none'] as const;

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

const sortedTags = (st: CollectionState) =>
  [...st.notes.values()]
    .map((n) => `${n.id}:${[...n.tags].sort(compareCodeUnits).join(',')}`)
    .sort(compareCodeUnits);

const observe = (st: CollectionState) => ({ sets: listStudySets(st), tags: sortedTags(st) });

function seedEvents(f: EventFactory, base: number): FlashEvent[] {
  const events: FlashEvent[] = [
    f.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: '한국어',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      },
      base,
    ),
  ];
  NOTE_TAGS.forEach((tags, i) => {
    events.push(
      f.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(DECK, `n${i}`),
          deck_id: DECK,
          source_key: `n${i}`,
          fields: { word: `w${i}`, meaning: `m${i}` },
          tags,
          created_order: i,
        },
        base + i + 1,
      ),
    );
  });
  return events;
}

const criterionArb = fc.record({
  mode: fc.constantFrom(...MODES),
  tags: fc.uniqueArray(fc.constantFrom(...POOL), { minLength: 1, maxLength: 3 }),
});
const tagOpArb: fc.Arbitrary<TagOperation> = fc.oneof(
  fc.record({
    kind: fc.constant('rename' as const),
    from: fc.constantFrom(...POOL),
    to: fc.constantFrom(...POOL, 'Fresh', '문법', 'fresh::sub'),
  }),
  fc.record({
    kind: fc.constant('merge' as const),
    from: fc.uniqueArray(fc.constantFrom(...POOL), { minLength: 1, maxLength: 3 }),
    into: fc.constantFrom('daily', 'Fresh', '한자'),
  }),
  fc.record({
    kind: fc.constant('delete' as const),
    tags: fc.uniqueArray(fc.constantFrom(...POOL), { minLength: 1, maxLength: 2 }),
  }),
);
const deviceArb = fc.integer({ min: 0, max: 2 });
const actionArb = fc.oneof(
  fc.record({
    kind: fc.constant('save' as const),
    device: deviceArb,
    set: fc.integer({ min: 0, max: 2 }),
    criterion: fc.option(criterionArb, { nil: undefined }),
    name: fc.option(fc.constantFrom('Trouble', '한자 set', 'Verbs'), { nil: undefined }),
    dt: fc.integer({ min: -5_000, max: 60_000 }),
  }),
  fc.record({
    kind: fc.constant('deleteSet' as const),
    device: deviceArb,
    set: fc.integer({ min: 0, max: 2 }),
    dt: fc.nat(60_000),
  }),
  fc.record({
    kind: fc.constant('tags' as const),
    device: deviceArb,
    op: tagOpArb,
    dt: fc.nat(60_000),
  }),
  fc.record({
    kind: fc.constant('sync' as const),
    from: deviceArb,
    to: deviceArb,
    dt: fc.nat(1_000),
  }),
);
type Action = typeof actionArb extends fc.Arbitrary<infer A> ? A : never;

/**
 * Three devices with skewed clocks. Each plans tag operations on ITS OWN (possibly stale) view, the
 * way the tag manager does, appending the note and Study Set events in one batch; `sync` copies one
 * device's events to another.
 */
function buildLog(actions: readonly Action[]): FlashEvent[] {
  const base = Date.UTC(2026, 2, 1, 1, 0, 0);
  const factories = [
    createEventFactory('dev-a', 0, createHlcState('dev-a', base)),
    createEventFactory('dev-b', 0, createHlcState('dev-b', base + 700)),
    createEventFactory('dev-c', 0, createHlcState('dev-c', base - 900)),
  ] as const;
  const seed = seedEvents(factories[0], base);
  const all: FlashEvent[] = [...seed];
  const views = [new Map<string, FlashEvent>(), new Map(), new Map()];
  for (const v of views) for (const e of seed) v.set(e.id, e);
  let clock = base + 1000;
  for (const act of actions) {
    clock += act.dt;
    if (act.kind === 'sync') {
      const to = views[act.to];
      for (const [id, e] of views[act.from] ?? []) to?.set(id, e);
      continue;
    }
    const f = factories[act.device] ?? factories[0];
    const view = views[act.device] ?? views[0];
    const created: FlashEvent[] = [];
    if (act.kind === 'save') {
      const payload: { set_id: string; name?: string; filter?: CardFilter } = {
        set_id: `set-${act.set}`,
      };
      if (act.criterion) payload.filter = normalizeCardFilter({ categories: act.criterion });
      if (act.name !== undefined || !act.criterion) payload.name = act.name ?? 'Trouble';
      created.push(f.create('StudySetSaved', payload, clock));
    } else if (act.kind === 'deleteSet') {
      created.push(f.create('StudySetDeleted', { set_id: `set-${act.set}` }, clock));
    } else {
      const st = replayChunked([...(view?.values() ?? [])], 1_000);
      const plan = planTagOperation(st, act.op);
      if (!plan.error) {
        for (const p of plan.payloads) created.push(f.create('NoteUpserted', p, clock));
        for (const p of planStudySetTagRewrites(st, act.op)) {
          created.push(f.create('StudySetSaved', p, clock));
        }
      }
    }
    for (const e of created) {
      view?.set(e.id, e);
      all.push(e);
    }
  }
  return all;
}

const isTagRewrite = (payload: unknown) =>
  typeof payload === 'object' &&
  payload !== null &&
  (payload as { tag_rewrite?: unknown }).tag_rewrite === true;

const matched = (st: CollectionState, filter: CardFilter) =>
  [...filterNoteIds(st, filter, { nowMs: Date.UTC(2026, 5, 1), tzOffsetMinutes: KST })].sort(
    compareCodeUnits,
  );

function applyOperation(st: CollectionState, op: TagOperation): CollectionState {
  const f = createEventFactory('dev-z', 0, createHlcState('dev-z', Date.UTC(2027, 0, 1)));
  const plan = planTagOperation(st, op);
  const events: FlashEvent[] = plan.payloads.map((p) => f.create('NoteUpserted', p));
  for (const p of planStudySetTagRewrites(st, op)) events.push(f.create('StudySetSaved', p));
  const next = deserializeCollectionState(
    JSON.parse(JSON.stringify(serializeCollectionState(st))) as ReturnType<
      typeof serializeCollectionState
    >,
  );
  applyEvents(next, events);
  return next;
}

describe('Study Sets follow category rename / merge / delete (fast-check)', () => {
  it('converges under any delivery order, chunking and snapshot hydration', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 2, maxLength: 30 }),
        fc.integer({ min: 1, max: 100_000 }),
        (actions, seed) => {
          const events = buildLog(actions);
          const reference = observe(replayChunked(events, events.length));
          const orders = [[...events].reverse(), shuffleWithSeed(events, seed)];
          for (const [i, order] of orders.entries()) {
            expect(observe(replayChunked(order, i + 2))).toEqual(reference);
          }
          const cut = Math.floor(events.length / 2);
          const shuffled = shuffleWithSeed(events, seed + 1);
          const hydrated = deserializeCollectionState(
            JSON.parse(
              JSON.stringify(serializeCollectionState(replayChunked(shuffled.slice(0, cut), 3))),
            ) as ReturnType<typeof serializeCollectionState>,
          );
          applyEvents(hydrated, [...shuffled.slice(cut), ...shuffled.slice(0, 4)]);
          expect(observe(hydrated)).toEqual(reference);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('a background category rewrite never creates or brings back a deleted set', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 2, maxLength: 30 }), (actions) => {
        const events = buildLog(actions);
        const withoutRewrites = events.filter(
          (e) => !(e.type === 'StudySetSaved' && isTagRewrite(e.payload)),
        );
        const ids = (list: readonly FlashEvent[]) =>
          listStudySets(replayChunked(list, list.length)).map((s) => s.id);
        expect(ids(events)).toEqual(ids(withoutRewrites));
      }),
      { numRuns: 120 },
    );
  });

  it('renaming a top-level category to a fresh name keeps every set on the same notes', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 20 }),
        fc.constantFrom(...TOP),
        // Names the log never uses: renaming onto a category in use is a merge, which can widen.
        fc.constantFrom('Renamed', '새 이름', 'renamed::sub'),
        (actions, from, to) => {
          const st = replayChunked(buildLog(actions), 50);
          const op: TagOperation = { kind: 'rename', from, to };
          const before = new Map(listStudySets(st).map((s) => [s.id, matched(st, s.filter)]));
          const after = applyOperation(st, op);
          for (const set of listStudySets(after)) {
            expect(matched(after, set.filter)).toEqual(before.get(set.id));
          }
          expect(planStudySetTagRewrites(after, op)).toEqual([]);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('a delete never changes which notes a set matches, and planning again does nothing', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 20 }),
        fc.uniqueArray(fc.constantFrom(...POOL), { minLength: 1, maxLength: 2 }),
        (actions, tags) => {
          const st = replayChunked(buildLog(actions), 50);
          const op: TagOperation = { kind: 'delete', tags };
          const resolved = resolveTagOperation(op);
          if ('error' in resolved) throw new Error(resolved.error.code);
          const after = applyOperation(st, op);
          for (const set of listStudySets(st)) {
            const rewritten = rewriteStudySetFilter(set.filter, resolved) ?? set.filter;
            expect(matched(after, rewritten)).toEqual(matched(after, set.filter));
          }
          expect(planStudySetTagRewrites(after, op)).toEqual([]);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('merge and rename are idempotent on the resulting state', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 20 }), tagOpArb, (actions, op) => {
        const st = replayChunked(buildLog(actions), 50);
        expect(planStudySetTagRewrites(applyOperation(st, op), op)).toEqual([]);
      }),
      { numRuns: 80 },
    );
  });
});
