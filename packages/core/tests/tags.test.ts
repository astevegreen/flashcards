import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createEventFactory,
  isCardSuspended,
  replayAllEvents,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import type { KnownEvent, NoteUpsertedPayload } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveNoteId } from '../src/ids.ts';
import { buildEventsFromCsv, exportCsv } from '../src/import/csv.ts';
import { BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';
import { filterNoteIds } from '../src/study/filter-lists.ts';
import { filterBrowseNoteIds } from '../src/tags/browse.ts';
import { createBulkEvents, planBulkNoteAction, type BulkEventDraft } from '../src/tags/bulk.ts';
import {
  normalizeTagList,
  planTagOperation,
  summarizeTags,
  tagKey,
  validateTagName,
  type TagOperation,
} from '../src/tags/index.ts';

const T0 = Date.UTC(2026, 2, 1, 0, 0, 0);
const DECK = 'deck-ko-tags';
const DECK2 = 'deck-ko-tags-2';
const JA_DECK = 'deck-ja-tags';

/** '한국어' typed on macOS arrives decomposed (NFD); everywhere else it is NFC. */
const KO_NFC = '한국어';
const KO_NFD = KO_NFC.normalize('NFD');

interface World {
  factory: EventFactory;
  events: KnownEvent[];
  state: () => CollectionState;
  apply: (payloads: readonly NoteUpsertedPayload[]) => void;
  applyDrafts: (drafts: readonly BulkEventDraft[]) => void;
}

function makeWorld(notes: ReadonlyArray<{ key: string; tags: string[]; deck?: string }>): World {
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
  let t = T0;
  const events: KnownEvent[] = [
    factory.create(
      'DeckCreated',
      { deck_id: DECK, name: 'Korean', note_type_id: 'preset:vocab-ko', language: 'ko' },
      (t += 1),
    ),
    factory.create(
      'DeckCreated',
      {
        deck_id: DECK2,
        name: 'Korean 2',
        note_type_id: 'preset:vocab-ko',
        language: 'ko',
        source: { kind: 'native' },
      },
      (t += 1),
    ),
    factory.create(
      'DeckCreated',
      { deck_id: JA_DECK, name: 'Japanese', note_type_id: 'preset:vocab-ja', language: 'ja' },
      (t += 1),
    ),
  ];
  notes.forEach((n, i) => {
    const deck = n.deck ?? DECK;
    events.push(
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(deck, n.key),
          deck_id: deck,
          source_key: n.key,
          fields: { word: n.key, meaning: `m-${n.key}` },
          tags: n.tags,
          created_order: i,
        },
        (t += 1),
      ),
    );
  });
  const world: World = {
    factory,
    events,
    state: () => replayAllEvents(events),
    apply(payloads) {
      t += 1;
      for (const p of payloads) events.push(factory.create('NoteUpserted', p, t));
    },
    applyDrafts(drafts) {
      t += 1;
      events.push(...createBulkEvents(factory, drafts, t));
    },
  };
  return world;
}

const noteId = (key: string, deck = DECK) => deriveNoteId(deck, key);
const tagsOf = (state: CollectionState, key: string, deck = DECK) =>
  state.notes.get(noteId(key, deck))?.tags;

const KOREAN_NOTES = [
  { key: '학교', tags: ['topik-1', 'hanja', 'daily', KO_NFC] },
  { key: '도서관', tags: ['topik-1', 'hanja', 'places', KO_NFD] },
  { key: '약속', tags: ['topik-1', 'daily', '문법::조사'] },
  { key: '경험', tags: ['topik-2', 'hanja', '문법::어미', 'Grammar'] },
];

describe('Phase 9 categories — normalization', () => {
  it('treats NFD and NFC Hangul as one category and writes NFC', () => {
    expect(KO_NFD).not.toBe(KO_NFC);
    expect(tagKey(KO_NFD)).toBe(tagKey(KO_NFC));
    expect(normalizeTagList([KO_NFD, ` ${KO_NFC} `, 'Grammar', 'grammar', '', 'a::b'])).toEqual([
      KO_NFC,
      'Grammar',
      'a::b',
    ]);
  });

  it('validates category names typed by the user', () => {
    expect(validateTagName('문법::조사')).toBeUndefined();
    expect(validateTagName('  ')).toBe('empty');
    expect(validateTagName('a,b')).toBe('separator_char');
    expect(validateTagName('a;b')).toBe('separator_char');
    expect(validateTagName('a::')).toBe('empty_segment');
    expect(validateTagName('::b')).toBe('empty_segment');
  });

  it('summarizes categories with hierarchy and counts (golden)', () => {
    const world = makeWorld(KOREAN_NOTES);
    const summary = summarizeTags(world.state());
    expect(summary.unnormalizedNoteCount).toBe(1); // 도서관 carries the NFD spelling
    expect(
      summary.tags.map((t) => [t.key, t.label, t.noteCount, t.directNoteCount, t.depth]),
    ).toEqual([
      ['daily', 'daily', 2, 2, 0],
      ['grammar', 'Grammar', 1, 1, 0],
      ['hanja', 'hanja', 3, 3, 0],
      ['places', 'places', 1, 1, 0],
      ['topik-1', 'topik-1', 3, 3, 0],
      ['topik-2', 'topik-2', 1, 1, 0],
      ['문법', '문법', 2, 0, 0],
      ['문법::어미', '문법::어미', 1, 1, 1],
      ['문법::조사', '문법::조사', 1, 1, 1],
      [KO_NFC, KO_NFC, 2, 2, 0],
    ]);
    expect(summary.tags.find((t) => t.key === '문법::조사')?.parentKey).toBe('문법');
  });

  it('lists categories only archived notes use, so they can still be renamed or deleted', () => {
    const world = makeWorld([...KOREAN_NOTES, { key: '옛날', tags: ['Old::Stuff', 'daily'] }]);
    world.events.push(world.factory.create('NoteArchived', { note_id: noteId('옛날') }, T0 + 500));
    const summary = summarizeTags(world.state());
    const row = (key: string) =>
      summary.tags
        .filter((t) => t.key === key)
        .map((t) => [t.label, t.noteCount, t.directNoteCount, t.archivedNoteCount]);
    expect(row('old')).toEqual([['Old', 0, 0, 1]]);
    expect(row('old::stuff')).toEqual([['Old::Stuff', 0, 0, 1]]);
    expect(row('daily')).toEqual([['daily', 2, 2, 1]]);
    expect(row('hanja')).toEqual([['hanja', 3, 3, 0]]);
    world.apply(planTagOperation(world.state(), { kind: 'delete', tags: ['old'] }).payloads);
    expect(summarizeTags(world.state()).tags.some((t) => t.key.startsWith('old'))).toBe(false);
  });

  it('normalize rewrites only the notes with unnormalized tags', () => {
    const world = makeWorld(KOREAN_NOTES);
    const plan = planTagOperation(world.state(), { kind: 'normalize' });
    expect(plan.payloads.map((p) => p.note_id)).toEqual([noteId('도서관')]);
    expect(plan.payloads[0]?.tags).toEqual(['topik-1', 'hanja', 'places', KO_NFC]);
    expect(plan.payloads[0]?.fields).toEqual({});
    world.apply(plan.payloads);
    expect(summarizeTags(world.state()).unnormalizedNoteCount).toBe(0);
    expect(planTagOperation(world.state(), { kind: 'normalize' }).payloads).toEqual([]);
  });
});

describe('Phase 9 tag manager — rename / merge / delete', () => {
  it('renames across the whole collection, NFD spellings included', () => {
    const world = makeWorld(KOREAN_NOTES);
    // The user types the NFD spelling (macOS); both notes move.
    const plan = planTagOperation(world.state(), { kind: 'rename', from: KO_NFD, to: 'korean' });
    expect(plan.error).toBeUndefined();
    expect(plan.payloads.map((p) => p.note_id).sort()).toEqual(
      [noteId('학교'), noteId('도서관')].sort(),
    );
    world.apply(plan.payloads);
    const state = world.state();
    expect(tagsOf(state, '학교')).toEqual(['topik-1', 'hanja', 'daily', 'korean']);
    expect(tagsOf(state, '도서관')).toEqual(['topik-1', 'hanja', 'places', 'korean']);
    // Fields and review-relevant data are untouched.
    expect(state.notes.get(noteId('학교'))?.fields).toEqual({ word: '학교', meaning: 'm-학교' });
  });

  it('renames a parent with its children and keeps child spelling', () => {
    const world = makeWorld(KOREAN_NOTES);
    world.apply(
      planTagOperation(world.state(), { kind: 'rename', from: '문법', to: 'grammar' }).payloads,
    );
    const state = world.state();
    expect(tagsOf(state, '약속')).toEqual(['topik-1', 'daily', 'grammar::조사']);
    // 경험 already had `Grammar`: the renamed child lands next to it.
    expect(tagsOf(state, '경험')).toEqual(['topik-2', 'hanja', 'grammar::어미', 'Grammar']);
  });

  it('merges several categories into one and dedupes', () => {
    const world = makeWorld(KOREAN_NOTES);
    const plan = planTagOperation(world.state(), {
      kind: 'merge',
      from: ['topik-1', 'topik-2'],
      into: 'TOPIK',
    });
    world.apply(plan.payloads);
    const state = world.state();
    expect(tagsOf(state, '학교')).toEqual(['TOPIK', 'hanja', 'daily', KO_NFC]);
    expect(tagsOf(state, '경험')).toEqual(['TOPIK', 'hanja', '문법::어미', 'Grammar']);
    const counts = summarizeTags(state).tags.find((t) => t.key === 'topik');
    expect(counts?.noteCount).toBe(4);
  });

  it('a case-only rename respells every note; renaming onto an existing tag merges', () => {
    const world = makeWorld(KOREAN_NOTES);
    world.apply(
      planTagOperation(world.state(), { kind: 'rename', from: 'Grammar', to: 'grammar' }).payloads,
    );
    expect(tagsOf(world.state(), '경험')).toEqual(['topik-2', 'hanja', '문법::어미', 'grammar']);
    world.apply(
      planTagOperation(world.state(), { kind: 'rename', from: 'places', to: 'daily' }).payloads,
    );
    // A touched note is written back fully normalized (its NFD tag becomes NFC).
    expect(tagsOf(world.state(), '도서관')).toEqual(['topik-1', 'hanja', 'daily', KO_NFC]);
  });

  it('rejects invalid targets and overlapping subtrees', () => {
    const state = makeWorld(KOREAN_NOTES).state();
    expect(planTagOperation(state, { kind: 'rename', from: 'daily', to: 'a,b' }).error).toEqual({
      code: 'invalid_name',
      problem: 'separator_char',
    });
    expect(
      planTagOperation(state, { kind: 'rename', from: '문법', to: '문법::x' }).error?.code,
    ).toBe('target_overlaps_source');
    expect(
      planTagOperation(state, { kind: 'merge', from: ['문법::조사'], into: '문법' }).error?.code,
    ).toBe('target_overlaps_source');
    expect(planTagOperation(state, { kind: 'delete', tags: ['  '] }).error?.code).toBe('no_source');
  });

  it('delete removes the category (and children) everywhere, archived notes included', () => {
    const world = makeWorld(KOREAN_NOTES);
    world.events.push(world.factory.create('NoteArchived', { note_id: noteId('약속') }, T0 + 500));
    const plan = planTagOperation(world.state(), { kind: 'delete', tags: ['문법'] });
    expect(plan.payloads.map((p) => p.note_id).sort()).toEqual(
      [noteId('약속'), noteId('경험')].sort(),
    );
    world.apply(plan.payloads);
    const state = world.state();
    expect(tagsOf(state, '약속')).toEqual(['topik-1', 'daily']);
    expect(tagsOf(state, '경험')).toEqual(['topik-2', 'hanja', 'Grammar']);
  });

  it('a renamed category keeps filtering the same notes', () => {
    const world = makeWorld(KOREAN_NOTES);
    const ctx = { nowMs: T0 + 10_000, tzOffsetMinutes: 540 };
    const before = filterNoteIds(
      world.state(),
      { categories: { mode: 'any', tags: ['hanja'] } },
      ctx,
    );
    world.apply(
      planTagOperation(world.state(), { kind: 'rename', from: 'hanja', to: '한자' }).payloads,
    );
    const after = filterNoteIds(
      world.state(),
      { categories: { mode: 'any', tags: ['한자'] } },
      ctx,
    );
    expect([...after].sort()).toEqual([...before].sort());
    expect(
      filterNoteIds(world.state(), { categories: { mode: 'any', tags: ['hanja'] } }, ctx).size,
    ).toBe(0);
  });
});

// --- Property tests -------------------------------------------------------------------------

const TAG_POOL = [
  KO_NFC,
  KO_NFD,
  '문법',
  '문법::조사',
  '문법::조사'.normalize('NFD'),
  '문법::어미',
  'Grammar',
  'grammar::Particles',
  'topik-1',
  'TOPIK-1',
  'hanja',
  ' daily ',
  'a::b::c',
];

const notesArb = fc
  .array(fc.subarray(TAG_POOL), { minLength: 1, maxLength: 8 })
  .map((lists) => lists.map((tags, i) => ({ key: `n${i}`, tags })));
const tagArb = fc.constantFrom(...TAG_POOL);
const targetArb = fc.constantFrom('korean', '한자', '문법', 'Grammar', 'x::y', KO_NFD, 'topik');

const opArb: fc.Arbitrary<TagOperation> = fc.oneof(
  fc.record({ kind: fc.constant('rename' as const), from: tagArb, to: targetArb }),
  fc.record({
    kind: fc.constant('merge' as const),
    from: fc.array(tagArb, { minLength: 1, maxLength: 3 }),
    into: targetArb,
  }),
  fc.record({
    kind: fc.constant('delete' as const),
    tags: fc.array(tagArb, { minLength: 1, maxLength: 3 }),
  }),
);

function keySet(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map(tagKey))].sort();
}

function inSubtree(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}::`);
}

describe('Phase 9 tag manager — properties', () => {
  it('every operation is idempotent; rename then merge settles in one pass', () => {
    fc.assert(
      fc.property(notesArb, opArb, opArb, (notes, first, second) => {
        const world = makeWorld(notes);
        for (const op of [first, second]) {
          const plan = planTagOperation(world.state(), op);
          if (plan.error) continue;
          world.apply(plan.payloads);
          expect(planTagOperation(world.state(), op).payloads).toEqual([]);
        }
      }),
      { numRuns: 120 },
    );
  });

  it('NFD and NFC spellings give the same categories and the same results', () => {
    fc.assert(
      fc.property(notesArb, opArb, (notes, op) => {
        const nfc = makeWorld(
          notes.map((n) => ({ ...n, tags: n.tags.map((t) => t.normalize('NFC')) })),
        );
        const nfd = makeWorld(
          notes.map((n) => ({ ...n, tags: n.tags.map((t) => t.normalize('NFD')) })),
        );
        const strip = (s: CollectionState) =>
          summarizeTags(s).tags.map((t) => [t.key, t.noteCount, t.directNoteCount]);
        expect(strip(nfd.state())).toEqual(strip(nfc.state()));

        const a = planTagOperation(nfc.state(), op);
        const b = planTagOperation(nfd.state(), op);
        expect(b.error).toEqual(a.error);
        if (a.error) return;
        nfc.apply(a.payloads);
        nfd.apply(b.payloads);
        // NFD notes are always rewritten, so the result is identical after normalizing both.
        nfc.apply(planTagOperation(nfc.state(), { kind: 'normalize' }).payloads);
        nfd.apply(planTagOperation(nfd.state(), { kind: 'normalize' }).payloads);
        for (const n of notes) {
          expect(keySet(tagsOf(nfd.state(), n.key))).toEqual(keySet(tagsOf(nfc.state(), n.key)));
          for (const t of tagsOf(nfd.state(), n.key) ?? []) expect(t).toBe(t.normalize('NFC'));
        }
      }),
      { numRuns: 100 },
    );
  });

  it('delete removes the category from every note and nothing else', () => {
    fc.assert(
      fc.property(notesArb, fc.array(tagArb, { minLength: 1, maxLength: 2 }), (notes, doomed) => {
        const world = makeWorld(notes);
        const before = world.state();
        const roots = doomed.map(tagKey);
        const plan = planTagOperation(before, { kind: 'delete', tags: doomed });
        expect(plan.error).toBeUndefined();
        world.apply(plan.payloads);
        const after = world.state();
        const touched = new Set(plan.payloads.map((p) => p.note_id));
        for (const n of notes) {
          const id = noteId(n.key);
          const prevKeys = keySet(before.notes.get(id)?.tags);
          const expected = prevKeys.filter((k) => !roots.some((r) => inSubtree(k, r)));
          expect(keySet(after.notes.get(id)?.tags)).toEqual(expected);
          if (expected.length === prevKeys.length) expect(touched.has(id)).toBe(false);
          expect(after.notes.get(id)?.fields).toEqual(before.notes.get(id)?.fields);
          expect(after.notes.get(id)?.deck_id).toBe(before.notes.get(id)?.deck_id);
        }
      }),
      { numRuns: 120 },
    );
  });
});

describe('Phase 9 Browse bulk edit', () => {
  const ids = (...keys: string[]) => keys.map((k) => noteId(k));

  it('adds and removes categories as one batch of NoteUpserted events', () => {
    const world = makeWorld(KOREAN_NOTES);
    const add = planBulkNoteAction(world.state(), ids('학교', '약속'), {
      kind: 'add_tags',
      tags: ['review-me', 'daily', KO_NFD],
    });
    expect(add.changedNoteCount).toBe(2);
    expect(add.events.every((e) => e.type === 'NoteUpserted')).toBe(true);
    world.applyDrafts(add.events);
    expect(tagsOf(world.state(), '학교')).toEqual([
      'topik-1',
      'hanja',
      'daily',
      KO_NFC,
      'review-me',
    ]);
    expect(tagsOf(world.state(), '약속')).toEqual([
      'topik-1',
      'daily',
      '문법::조사',
      'review-me',
      KO_NFC,
    ]);
    // Re-running is a no-op.
    expect(
      planBulkNoteAction(world.state(), ids('학교', '약속'), {
        kind: 'add_tags',
        tags: ['review-me'],
      }).events,
    ).toEqual([]);

    const remove = planBulkNoteAction(world.state(), ids('학교', '약속', '경험'), {
      kind: 'remove_tags',
      tags: ['review-me', '문법'],
    });
    expect(remove.changedNoteCount).toBe(3);
    world.applyDrafts(remove.events);
    expect(tagsOf(world.state(), '약속')).toEqual(['topik-1', 'daily', KO_NFC]);
    expect(tagsOf(world.state(), '경험')).toEqual(['topik-2', 'hanja', 'Grammar']);

    expect(
      planBulkNoteAction(world.state(), ids('학교'), { kind: 'add_tags', tags: ['a;b'] }).error,
    ).toEqual({
      code: 'invalid_tag',
      tag: 'a;b',
    });
  });

  it('moves notes to a deck with the same note type and keeps card ids', () => {
    const world = makeWorld([...KOREAN_NOTES, { key: '일본', tags: [], deck: JA_DECK }]);
    const before = world.state();
    const cardsBefore = [...(before.cardIdsByNote.get(noteId('학교')) ?? [])].sort();
    const plan = planBulkNoteAction(before, ids('학교', '약속'), {
      kind: 'move_deck',
      deckId: DECK2,
    });
    expect(plan.events.map((e) => e.type)).toEqual(['NoteUpserted', 'NoteUpserted']);
    world.applyDrafts(plan.events);
    const after = world.state();
    expect(after.notes.get(noteId('학교'))?.deck_id).toBe(DECK2);
    expect(after.notes.get(noteId('학교'))?.tags).toEqual(KOREAN_NOTES[0]?.tags);
    expect([...(after.cardIdsByNote.get(noteId('학교')) ?? [])].sort()).toEqual(cardsBefore);
    for (const id of cardsBefore) expect(after.cards.get(id)?.deck_id).toBe(DECK2);

    const mismatch = planBulkNoteAction(after, [noteId('일본', JA_DECK)], {
      kind: 'move_deck',
      deckId: DECK,
    });
    expect(mismatch.error).toEqual({
      code: 'note_type_mismatch',
      noteIds: [noteId('일본', JA_DECK)],
    });
    world.events.push(
      world.factory.create(
        'DeckCreated',
        {
          deck_id: 'deck-sheet',
          name: 'Sheet',
          note_type_id: 'preset:vocab-ko',
          language: 'ko',
          source: { kind: 'google_sheets', external_id: 'sheet-1' },
        },
        T0 + 900,
      ),
    );
    expect(
      planBulkNoteAction(world.state(), ids('학교'), { kind: 'move_deck', deckId: 'deck-sheet' })
        .error?.code,
    ).toBe('source_linked');
    expect(
      planBulkNoteAction(after, ids('학교'), { kind: 'move_deck', deckId: 'nope' }).error,
    ).toEqual({
      code: 'unknown_deck',
    });
  });

  it('refuses a move that would give the target deck two notes with one source_key', () => {
    // 학교 is in both decks (e.g. added from the dictionary twice); 약속 only in DECK.
    const world = makeWorld([
      ...KOREAN_NOTES,
      { key: '학교', tags: [], deck: DECK2 },
      { key: '경험', tags: [], deck: DECK2 },
    ]);
    world.events.push(
      world.factory.create('NoteArchived', { note_id: noteId('경험', DECK2) }, T0 + 500),
    );
    const before = world.state();

    const clash = planBulkNoteAction(before, ids('학교', '약속'), {
      kind: 'move_deck',
      deckId: DECK2,
    });
    expect(clash).toEqual({
      events: [],
      changedNoteCount: 0,
      error: { code: 'source_key_conflict', noteIds: [noteId('학교')] },
    });
    // An archived note still owns its key (imports match and restore it).
    expect(
      planBulkNoteAction(before, ids('경험'), { kind: 'move_deck', deckId: DECK2 }).error,
    ).toEqual({ code: 'source_key_conflict', noteIds: [noteId('경험')] });
    // Two moved notes sharing a key clash with each other.
    const both = planBulkNoteAction(before, [noteId('학교'), noteId('학교', DECK2)], {
      kind: 'move_deck',
      deckId: DECK,
    });
    expect(both.error).toEqual({ code: 'source_key_conflict', noteIds: [noteId('학교', DECK2)] });
    // Selecting a note already in the target alongside a free one only moves the free one.
    const ok = planBulkNoteAction(before, [noteId('약속'), noteId('학교', DECK2)], {
      kind: 'move_deck',
      deckId: DECK2,
    });
    expect(ok.error).toBeUndefined();
    expect(ok.changedNoteCount).toBe(1);
  });

  it('re-importing the target deck CSV updates moved notes instead of duplicating them', () => {
    const world = makeWorld(KOREAN_NOTES);
    const plan = planBulkNoteAction(world.state(), ids('학교', '약속'), {
      kind: 'move_deck',
      deckId: DECK2,
    });
    world.applyDrafts(plan.events);
    const moved = world.state();
    const deck2Ids = () =>
      [...world.state().notes.values()]
        .filter((n) => n.deck_id === DECK2)
        .map((n) => n.id)
        .sort();
    const before = deck2Ids();
    expect(before).toEqual([noteId('학교'), noteId('약속')].sort());

    const koNoteType = BUILTIN_NOTE_TYPES.find((nt) => nt.id === 'preset:vocab-ko');
    if (!koNoteType) throw new Error('Missing preset:vocab-ko');
    const csv = exportCsv(moved, { deckId: DECK2 }).text.replace('m-학교', 'school');
    const res = buildEventsFromCsv(csv, {
      deckId: DECK2,
      noteType: koNoteType,
      eventFactory: world.factory,
      nowMs: T0 + 5000,
      existingNotes: moved.notes.values(),
    });
    expect(res.warnings).toEqual([]);
    world.events.push(...res.events);
    expect(deck2Ids()).toEqual(before);
    expect(world.state().notes.get(noteId('학교'))?.fields.meaning).toBe('school');
  });

  it('suspends, unsuspends and archives in one batch each', () => {
    const world = makeWorld(KOREAN_NOTES);
    const selection = ids('학교', '도서관');
    const suspend = planBulkNoteAction(world.state(), selection, { kind: 'suspend' });
    expect(suspend.changedNoteCount).toBe(2);
    expect(suspend.events.every((e) => e.type === 'CardSuspended')).toBe(true);
    world.applyDrafts(suspend.events);
    const st = world.state();
    for (const id of selection) {
      for (const cardId of st.cardIdsByNote.get(id) ?? [])
        expect(isCardSuspended(st, cardId)).toBe(true);
    }
    expect(planBulkNoteAction(st, selection, { kind: 'suspend' }).events).toEqual([]);
    world.applyDrafts(planBulkNoteAction(st, selection, { kind: 'unsuspend' }).events);
    const st2 = world.state();
    for (const id of selection) {
      for (const cardId of st2.cardIdsByNote.get(id) ?? [])
        expect(isCardSuspended(st2, cardId)).toBe(false);
    }

    const archive = planBulkNoteAction(st2, selection, { kind: 'archive' });
    expect(archive.events).toEqual([
      ...selection
        .slice()
        .sort()
        .map((id) => ({ type: 'NoteArchived', payload: { note_id: id } })),
    ]);
    world.applyDrafts(archive.events);
    expect(world.state().notes.get(noteId('학교'))?.archived).toBe(true);
  });
});

describe('Phase 9 Browse "Due today" filter', () => {
  it('leaves suspended cards out of Due today but keeps them under Suspended', () => {
    const world = makeWorld(KOREAN_NOTES);
    // 2026-03-01 00:00 UTC = 09:00 KST: rate one card of 학교 and 도서관 Again (due again in minutes).
    const at = T0 + 60_000;
    const st0 = world.state();
    const cardOf = (key: string) => [...(st0.cardIdsByNote.get(noteId(key)) ?? [])].sort()[0] ?? '';
    for (const [i, key] of ['학교', '도서관'].entries()) {
      world.events.push(
        world.factory.create(
          'ReviewRecorded',
          {
            review_id: `rev-${i}`,
            card_id: cardOf(key),
            rating: 1,
            reviewed_at: at,
            tz_offset: 540,
            duration_ms: 1000,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: at,
          },
          at,
        ),
      );
    }
    const ctx = { nowMs: at + 3_600_000, tzOffsetMinutes: 540 };
    const due = { states: ['due' as const] };
    expect([...filterBrowseNoteIds(world.state(), due, ctx)].sort()).toEqual(
      [noteId('학교'), noteId('도서관')].sort(),
    );

    world.events.push(world.factory.create('CardSuspended', { card_id: cardOf('학교') }, at + 1));
    const st = world.state();
    expect([...filterBrowseNoteIds(st, due, ctx)]).toEqual([noteId('도서관')]);
    // The plain shared filter still reports the suspended card as due (Study excludes it itself).
    expect(filterNoteIds(st, due, ctx).has(noteId('학교'))).toBe(true);
    expect(filterBrowseNoteIds(st, { states: ['suspended'] }, ctx).has(noteId('학교'))).toBe(true);
    expect(filterBrowseNoteIds(st, { states: ['due', 'suspended'] }, ctx).has(noteId('학교'))).toBe(
      true,
    );
  });
});
