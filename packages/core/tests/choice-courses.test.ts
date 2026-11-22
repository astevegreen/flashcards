import { describe, expect, it } from 'vitest';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import {
  applyEvents,
  buildSampleDeckEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveCardId,
  deriveNoteId,
  evaluateCourseProgress,
  findCoursePrerequisiteCycle,
  generateChoiceOptions,
  replayAllEvents,
  type Course,
  type FlashEvent,
} from '../src/index.ts';

describe('Multiple-choice distractor generator (§5.2)', () => {
  it('draws 3 unique distractors prioritizing shared tags and orders deterministically', () => {
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const deckId = 'deck-choice';
    const layoutId = 'layout:vocab-ko:recognition';

    const notesData = [
      { key: 'n1', word: '사과', meaning: 'apple', tags: ['fruit'] },
      { key: 'n2', word: '바나나', meaning: 'banana', tags: ['fruit'] },
      { key: 'n3', word: '포도', meaning: 'grape', tags: ['fruit'] },
      { key: 'n4', word: '딸기', meaning: 'strawberry', tags: ['fruit'] },
      { key: 'n5', word: '의자', meaning: 'chair', tags: ['furniture'] },
      // Duplicate meaning to ensure deduplication
      { key: 'n6', word: '사과2', meaning: 'Apple', tags: ['fruit'] },
    ];

    const evs: FlashEvent[] = [
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Korean Choice',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: t0,
        },
        t0,
      ),
      ...notesData.map((n, i) =>
        factory.create(
          'NoteUpserted',
          {
            note_id: deriveNoteId(deckId, n.key),
            deck_id: deckId,
            source_key: n.key,
            fields: { word: n.word, meaning: n.meaning },
            tags: n.tags,
            created_order: i,
          },
          t0 + i + 1,
        ),
      ),
    ];

    const state = replayAllEvents(evs);
    const card = state.cards.get(deriveCardId(deriveNoteId(deckId, 'n1'), layoutId, 0));
    expect(card).toBeDefined();
    if (!card) return;

    const qA = generateChoiceOptions(state, card, 20500);
    const qB = generateChoiceOptions(state, card, 20500);
    expect(qA).toEqual(qB); // Deterministic for same studyDayIndex
    expect(qA.insufficientDistractors).toBe(false);
    expect(qA.options).toHaveLength(4);
    expect(qA.options.filter((o) => o.isCorrect)).toHaveLength(1);
    expect(qA.options.find((o) => o.isCorrect)?.text).toBe('apple');

    // Should prioritize the 3 other 'fruit' notes over 'furniture' ('chair')
    const texts = new Set(qA.options.map((o) => o.text));
    expect(texts).toEqual(new Set(['apple', 'banana', 'grape', 'strawberry']));
  });

  it('falls back gracefully when deck has fewer than 4 unique answers', () => {
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const deckId = 'deck-small';
    const layoutId = 'layout:vocab-ko:recognition';

    const state = replayAllEvents([
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Small Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: t0,
        },
        t0,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(deckId, 's1'),
          deck_id: deckId,
          source_key: 's1',
          fields: { word: '물', meaning: 'water' },
          tags: [],
          created_order: 0,
        },
        t0 + 1,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(deckId, 's2'),
          deck_id: deckId,
          source_key: 's2',
          fields: { word: '불', meaning: 'fire' },
          tags: [],
          created_order: 1,
        },
        t0 + 2,
      ),
    ]);

    const card = state.cards.get(deriveCardId(deriveNoteId(deckId, 's1'), layoutId, 0));
    expect(card).toBeDefined();
    if (!card) return;

    const q = generateChoiceOptions(state, card, 20500);
    expect(q.options).toHaveLength(2);
    expect(q.insufficientDistractors).toBe(true);
    expect(q.options.filter((o) => o.isCorrect)).toHaveLength(1);
  });
});

describe('Course progress & unlock evaluation (§2.3)', () => {
  it('locks dependent deck until prerequisite page receives PageRead', () => {
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const pageId = 'page-intro';
    const deckId = 'deck-unit1';
    const course: Course = {
      id: 'course-1',
      name: 'Starter Course',
      items: [
        { kind: 'page', ref_id: pageId },
        { kind: 'deck', ref_id: deckId, unlocks_after_page_id: pageId },
      ],
    };

    const state = applyEvents(createEmptyState(), [
      factory.create(
        'PageUpserted',
        {
          page_id: pageId,
          slug: 'intro',
          title: 'Intro Guide',
          markdown: '# Intro',
          tags: [],
        },
        t0,
      ),
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Unit 1 Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA,
          language: 'ja',
          created_at: t0,
        },
        t0 + 1,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(deckId, 'u1'),
          deck_id: deckId,
          source_key: 'u1',
          fields: { word: '猫', reading: 'ねこ', meaning: 'cat' },
          tags: [],
          created_order: 0,
        },
        t0 + 2,
      ),
      factory.create('CourseChanged', { course }, t0 + 3),
    ]);

    const before = evaluateCourseProgress(state, course, {
      nowMs: t0 + 5000,
      tzOffsetMinutes: 0,
    });
    expect(before.items[0]?.unlocked).toBe(true);
    expect(before.items[0]?.completed).toBe(false);
    expect(before.items[1]?.unlocked).toBe(false);
    expect(before.items[1]?.prerequisitePageTitle).toBe('Intro Guide');
    expect(before.items[1]?.dueCounts?.new).toBe(1);
    expect(before.completedItems).toBe(0);

    // Emit PageRead -> deck unlocks immediately
    applyEvents(state, [
      factory.create('PageRead', { page_id: pageId, read_at: t0 + 6000 }, t0 + 6000),
    ]);

    const after = evaluateCourseProgress(state, course, {
      nowMs: t0 + 7000,
      tzOffsetMinutes: 0,
    });
    expect(after.items[0]?.completed).toBe(true);
    expect(after.items[0]?.readAt).toBe(t0 + 6000);
    expect(after.items[1]?.unlocked).toBe(true);
    expect(after.completedItems).toBe(1);
    expect(after.unlockedItems).toBe(2);
  });

  it('preserves Course -> Page and Course -> Deck references across full .flashpkg backup export & clean restore', () => {
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const srcFactory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const srcState = replayAllEvents(buildSampleDeckEvents(srcFactory, t0));
    const archiveBytes = exportFlashpkg(srcState, { name: 'Full Backup' });

    const cleanState = createEmptyState();
    const dstFactory = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 1000));
    const imported = importFlashpkg(archiveBytes, cleanState, dstFactory, { nowMs: t0 + 1000 });
    applyEvents(cleanState, imported.events);

    const restoredCourse = [...cleanState.courses.values()][0];
    expect(restoredCourse).toBeDefined();
    if (!restoredCourse) return;

    const before = evaluateCourseProgress(cleanState, restoredCourse, {
      nowMs: t0 + 2000,
      tzOffsetMinutes: 0,
    });
    expect(before.items).toHaveLength(2);
    expect(before.items[0]?.missing).toBe(false);
    expect(before.items[0]?.kind).toBe('page');
    expect(before.items[0]?.title).toBe('Japanese Particles: は vs が');
    expect(before.items[1]?.missing).toBe(false);
    expect(before.items[1]?.kind).toBe('deck');
    expect(before.items[1]?.title).toBe('Japanese Particles Cloze (JA)');
    expect(before.items[1]?.unlocked).toBe(false);
    expect(before.items[1]?.prerequisitePageTitle).toBe('Japanese Particles: は vs が');

    // Mark restored page read -> restored deck unlocks!
    const restoredPageId = before.items[0]?.ref_id;
    expect(restoredPageId).toBeDefined();
    if (!restoredPageId) return;
    applyEvents(cleanState, [
      dstFactory.create('PageRead', { page_id: restoredPageId, read_at: t0 + 3000 }, t0 + 3000),
    ]);
    const after = evaluateCourseProgress(cleanState, restoredCourse, {
      nowMs: t0 + 4000,
      tzOffsetMinutes: 0,
    });
    expect(after.items[1]?.unlocked).toBe(true);
  });

  it('exports a single course with only its own decks and pages, and a single page alone', () => {
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const srcFactory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const srcState = replayAllEvents(buildSampleDeckEvents(srcFactory, t0));
    const course = [...srcState.courses.values()][0];
    const page = [...srcState.pages.values()][0];
    expect(course && page).toBeTruthy();
    if (!course || !page) return;

    const courseBytes = exportFlashpkg(srcState, { courseId: course.id });
    const courseDst = createEmptyState();
    const f1 = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 1000));
    const courseImport = importFlashpkg(courseBytes, courseDst, f1, { nowMs: t0 + 1000 });
    applyEvents(courseDst, courseImport.events);
    expect(courseImport.manifest.name).toBe(course.name);
    expect(courseDst.decks.size).toBe(1);
    expect([...courseDst.decks.values()][0]?.name).toBe('Japanese Particles Cloze (JA)');
    expect(courseDst.pages.size).toBe(1);
    expect(courseDst.courses.size).toBe(1);

    const pageBytes = exportFlashpkg(srcState, { pageId: page.id });
    const pageDst = createEmptyState();
    const f2 = createEventFactory('dev-c', 0, createHlcState('dev-c', t0 + 1000));
    const pageImport = importFlashpkg(pageBytes, pageDst, f2, { nowMs: t0 + 1000 });
    applyEvents(pageDst, pageImport.events);
    expect(pageDst.decks.size).toBe(0);
    expect(pageDst.courses.size).toBe(0);
    expect([...pageDst.pages.values()][0]?.title).toBe(page.title);
  });

  it('leaves deleted (archived) courses out of a full backup', () => {
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const state = replayAllEvents(buildSampleDeckEvents(factory, t0));
    const course = [...state.courses.values()][0];
    if (!course) throw new Error('sample course missing');
    applyEvents(state, [
      factory.create('CourseChanged', { course: { ...course, archived: true } }, t0 + 1000),
    ]);
    expect(state.courses.get(course.id)?.archived).toBe(true);

    const dst = createEmptyState();
    const f2 = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 2000));
    const imported = importFlashpkg(exportFlashpkg(state), dst, f2, { nowMs: t0 + 2000 });
    applyEvents(dst, imported.events);
    expect(dst.courses.size).toBe(0);
    expect(dst.pages.size).toBe(1);
  });

  it('flags missing prerequisite pages, missing pages, and archived decks explicitly', () => {
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const archivedDeckId = 'deck-archived';
    const activeDeckId = 'deck-active';

    const state = applyEvents(createEmptyState(), [
      factory.create(
        'DeckCreated',
        {
          deck_id: archivedDeckId,
          name: 'Retired Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA,
          language: 'ja',
          created_at: t0,
        },
        t0,
      ),
      factory.create('DeckSettingsChanged', { deck_id: archivedDeckId, archived: true }, t0 + 1),
      factory.create(
        'DeckCreated',
        {
          deck_id: activeDeckId,
          name: 'Active Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA,
          language: 'ja',
          created_at: t0 + 2,
        },
        t0 + 2,
      ),
    ]);

    const course: Course = {
      id: 'course-broken',
      name: 'Broken References Course',
      items: [
        { kind: 'page', ref_id: 'page-nonexistent' },
        { kind: 'deck', ref_id: archivedDeckId },
        { kind: 'deck', ref_id: activeDeckId, unlocks_after_page_id: 'page-missing-prereq' },
      ],
    };

    const progress = evaluateCourseProgress(state, course, {
      nowMs: t0 + 5000,
      tzOffsetMinutes: 0,
    });

    expect(progress.items[0]?.missing).toBe(true);
    expect(progress.items[0]?.unlocked).toBe(true);

    expect(progress.items[1]?.missing).toBe(true);
    expect(progress.items[1]?.archived).toBe(true);
    expect(progress.items[1]?.title).toBe('Retired Deck');

    expect(progress.items[2]?.missing).toBe(false);
    expect(progress.items[2]?.unlocked).toBe(false);
    expect(progress.items[2]?.prerequisiteMissing).toBe(true);
    expect(progress.items[2]?.prerequisitePageTitle).toBeUndefined();
  });

  it('detects 1-node, 2-node, and 3-node prerequisite cycles while allowing acyclic chains and deck prerequisites', () => {
    expect(
      findCoursePrerequisiteCycle([
        { kind: 'page', ref_id: 'p1' },
        { kind: 'page', ref_id: 'p2', unlocks_after_page_id: 'p1' },
        { kind: 'page', ref_id: 'p3', unlocks_after_page_id: 'p2' },
        { kind: 'deck', ref_id: 'd1', unlocks_after_page_id: 'p3' },
      ]),
    ).toBeNull();

    // Self-loop
    expect(
      findCoursePrerequisiteCycle([{ kind: 'page', ref_id: 'p1', unlocks_after_page_id: 'p1' }]),
    ).toEqual(['p1', 'p1']);

    // 2-node cycle
    const twoNode = findCoursePrerequisiteCycle([
      { kind: 'page', ref_id: 'p1', unlocks_after_page_id: 'p2' },
      { kind: 'page', ref_id: 'p2', unlocks_after_page_id: 'p1' },
    ]);
    expect(twoNode).not.toBeNull();
    expect(twoNode?.[0]).toBe(twoNode?.[twoNode.length - 1]);
    expect(new Set(twoNode)).toEqual(new Set(['p1', 'p2']));

    // 3-node cycle
    const threeNode = findCoursePrerequisiteCycle([
      { kind: 'page', ref_id: 'p1', unlocks_after_page_id: 'p2' },
      { kind: 'page', ref_id: 'p2', unlocks_after_page_id: 'p3' },
      { kind: 'page', ref_id: 'p3', unlocks_after_page_id: 'p1' },
    ]);
    expect(threeNode).not.toBeNull();
    expect(new Set(threeNode)).toEqual(new Set(['p1', 'p2', 'p3']));
  });
});
