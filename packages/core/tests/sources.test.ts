import * as fc from 'fast-check';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { applyEvents, createEmptyState, createEventFactory } from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId, encodeUtf8 } from '../src/ids.ts';
import { importFlashpkg } from '../src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPE_IDS, BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';
import {
  applyCardIdsToGridAndSerialize,
  assertSafeHttpsUrl,
  CatalogValidationError,
  columnIndexToA1,
  comparePackageVersions,
  diffTabularSource,
  filterSafeWriteBackCells,
  inferPresetNoteTypeId,
  mapTabularHeaders,
  normalizeMarkdownPage,
  PageSecurityError,
  parseAndValidateFamilyCatalog,
  parseImageCellValue,
  sanitizePageMarkdown,
  sha256Hex,
  sha256String,
} from '../src/sources/index.ts';

const KO_NOTE_TYPE = BUILTIN_NOTE_TYPES.find((nt) => nt.id === BUILTIN_NOTE_TYPE_IDS.VOCAB_KO);
const JA_NOTE_TYPE = BUILTIN_NOTE_TYPES.find((nt) => nt.id === BUILTIN_NOTE_TYPE_IDS.VOCAB_JA);
if (!KO_NOTE_TYPE || !JA_NOTE_TYPE) {
  throw new Error('Built-in KO/JA note types missing');
}

function makeDeckState(deckId = 'deck-sheet-1', noteTypeId: string = KO_NOTE_TYPE.id) {
  const state = createEmptyState();
  const factory = createEventFactory('dev-1', 0, createHlcState('dev-1', 1000));
  applyEvents(state, [
    factory.create(
      'DeckCreated',
      {
        deck_id: deckId,
        name: 'Sheet Deck',
        note_type_id: noteTypeId,
        language: 'ko',
        created_at: 1000,
      },
      1000,
    ),
  ]);
  return { state, factory, deckId };
}

describe('@flash/core/sources — hash & A1 helpers', () => {
  it('computes standard FIPS 180-4 SHA-256 vectors accurately', () => {
    expect(sha256String('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256String('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('converts 0-based column indices to A1 column letters', () => {
    expect(columnIndexToA1(0)).toBe('A');
    expect(columnIndexToA1(25)).toBe('Z');
    expect(columnIndexToA1(26)).toBe('AA');
    expect(columnIndexToA1(27)).toBe('AB');
    expect(columnIndexToA1(701)).toBe('ZZ');
    expect(columnIndexToA1(702)).toBe('AAA');
  });
});

describe('@flash/core/sources — Tabular header mapping & =IMAGE() parsing', () => {
  it('maps headers by name, flags unknown/duplicate headers, and supports Image/Tags/Card ID', () => {
    const mapped = mapTabularHeaders(
      ['Meaning', 'Word', 'Image', 'Tags', 'Word', 'WeirdCol', 'Card ID'],
      KO_NOTE_TYPE,
    );
    expect(mapped.mappedHeaders).toEqual({
      Meaning: 'meaning',
      Word: 'word',
      Image: 'image',
      Tags: 'tags',
      'Card ID': 'source_key',
    });
    expect(mapped.cardIdColumnIndex).toBe(6);
    expect(mapped.imageColumnIndices).toEqual([2]);
    expect(mapped.warnings.map((w) => w.code)).toEqual(['duplicate_header', 'unknown_header']);
  });

  it('infers built-in note types from headers', () => {
    expect(inferPresetNoteTypeId(['Word', 'Pinyin', 'Meaning']).noteTypeId).toBe(
      BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH,
    );
    expect(inferPresetNoteTypeId(['Character', 'Eumhun', 'Meaning']).noteTypeId).toBe(
      BUILTIN_NOTE_TYPE_IDS.HANJA,
    );
    expect(inferPresetNoteTypeId(['Grammar Point', 'Explanation']).noteTypeId).toBe(
      BUILTIN_NOTE_TYPE_IDS.GRAMMAR,
    );
  });

  it('parses =IMAGE(https://...) formulas and rejects unsafe schemes or unsupported formulas', () => {
    expect(parseImageCellValue('=IMAGE("https://example.com/pic.png", 1)')).toEqual({
      value: 'https://example.com/pic.png',
    });
    expect(parseImageCellValue("=image('https://cdn.example.org/a.jpg')")).toEqual({
      value: 'https://cdn.example.org/a.jpg',
    });
    expect(parseImageCellValue('=IMAGE("http://insecure.example.com/a.png")').warning?.code).toBe(
      'unsafe_url',
    );
    expect(parseImageCellValue('=IMAGE(A2)').warning?.code).toBe('unsupported_image_formula');
    expect(parseImageCellValue('javascript:alert(1)').warning?.code).toBe('unsafe_url');
    expect(parseImageCellValue('images/apple.png', { allowRelativePath: true })).toEqual({
      value: 'images/apple.png',
      isRelativePath: true,
    });
    expect(parseImageCellValue('../secret.png', { allowRelativePath: true }).warning?.code).toBe(
      'unsafe_url',
    );
  });
});

describe('@flash/core/sources — Tabular diff, soft-archive/restore, and race-safe write-back', () => {
  it('assigns missing/duplicate Card IDs, diffs by content hash, and soft-archives/restores preserving review history', () => {
    const { state, factory, deckId } = makeDeckState();
    let idSeq = 0;
    const genId = () => `cid-${++idSeq}`;

    // Pull 1: two rows without Card IDs, plus trailing empty rows and an embedded image warning
    const grid1 = [
      ['Word', 'Meaning', 'Image', 'Tags'],
      ['학교', 'school', '=IMAGE("https://img.example.com/school.png")', 'topik-1'],
      ['선생님', 'teacher', '', 'topik-1; people'],
      ['', '', '', ''],
    ];

    const res1 = diffTabularSource({
      deckId,
      noteType: KO_NOTE_TYPE,
      state,
      eventFactory: factory,
      grid: grid1,
      identityMode: 'card_id',
      canWriteBack: true,
      embeddedImageRows: [3],
      nowMs: 2000,
      generateCardId: genId,
    });

    expect(res1.stats).toEqual({
      totalRows: 2,
      added: 2,
      updated: 0,
      unchanged: 0,
      archived: 0,
      restored: 0,
      skipped: 0,
    });
    expect(res1.writeBackPlan.needsHeaderCell?.colLetter).toBe('E');
    expect(res1.writeBackPlan.cells).toHaveLength(2);
    expect(res1.warnings.some((w) => w.code === 'embedded_in_cell_image')).toBe(true);
    applyEvents(state, res1.events);

    const schoolNoteId = deriveNoteId(deckId, 'cid-1');
    const teacherNoteId = deriveNoteId(deckId, 'cid-2');
    expect(state.notes.get(schoolNoteId)?.fields['image']).toBe(
      'https://img.example.com/school.png',
    );

    // Record a review on school card
    const schoolCardId = deriveCardId(schoolNoteId, 'layout:vocab-ko:recognition', 0);
    applyEvents(state, [
      factory.create(
        'ReviewRecorded',
        {
          review_id: 'rev-1',
          card_id: schoolCardId,
          rating: 3,
          reviewed_at: 3000,
          tz_offset: 0,
          duration_ms: 1200,
          answer_mode: 'flip',
          fsrs_params_version: 0,
          resulting_due_at: 90_000,
        },
        3000,
      ),
    ]);
    expect(state.cards.get(schoolCardId)?.schedule.reps).toBe(1);

    // Pull 2: unchanged rows emit ZERO events
    const grid2 = [
      ['Word', 'Meaning', 'Image', 'Tags', 'Card ID'],
      ['학교', 'school', '=IMAGE("https://img.example.com/school.png")', 'topik-1', 'cid-1'],
      ['선생님', 'teacher', '', 'people, topik-1', 'cid-2'],
    ];
    const res2 = diffTabularSource({
      deckId,
      noteType: KO_NOTE_TYPE,
      state,
      eventFactory: factory,
      grid: grid2,
      identityMode: 'card_id',
      canWriteBack: true,
      nowMs: 4000,
      generateCardId: genId,
    });
    expect(res2.events).toHaveLength(0);
    expect(res2.stats.unchanged).toBe(2);

    // Pull 3: delete school row, edit teacher row, and duplicate cid-2 on a copied row
    const grid3 = [
      ['Word', 'Meaning', 'Image', 'Tags', 'Card ID'],
      ['선생님', 'teacher / instructor', '', 'topik-1', 'cid-2'],
      ['학생', 'student', '', 'topik-1', 'cid-2'],
    ];
    const res3 = diffTabularSource({
      deckId,
      noteType: KO_NOTE_TYPE,
      state,
      eventFactory: factory,
      grid: grid3,
      identityMode: 'card_id',
      canWriteBack: true,
      nowMs: 5000,
      generateCardId: genId,
    });
    expect(res3.stats.archived).toBe(1);
    expect(res3.stats.updated).toBe(1);
    expect(res3.stats.added).toBe(1);
    expect(res3.warnings.some((w) => w.code === 'duplicate_card_id')).toBe(true);
    expect(res3.writeBackPlan.cells).toHaveLength(1);
    expect(res3.writeBackPlan.cells[0]?.reason).toBe('duplicate');
    expect(res3.writeBackPlan.cells[0]?.newCardId).toBe('cid-3');
    applyEvents(state, res3.events);

    expect(state.notes.get(schoolNoteId)?.archived).toBe(true);
    expect(state.cards.has(schoolCardId)).toBe(false);
    expect(state.notes.get(teacherNoteId)?.fields['meaning']).toBe('teacher / instructor');

    // Pull 4: restore school row -> NoteRestored preserves full FSRS review history!
    const grid4 = [
      ['Word', 'Meaning', 'Image', 'Tags', 'Card ID'],
      ['학교', 'school', '=IMAGE("https://img.example.com/school.png")', 'topik-1', 'cid-1'],
      ['선생님', 'teacher / instructor', '', 'topik-1', 'cid-2'],
      ['학생', 'student', '', 'topik-1', 'cid-3'],
    ];
    const res4 = diffTabularSource({
      deckId,
      noteType: KO_NOTE_TYPE,
      state,
      eventFactory: factory,
      grid: grid4,
      identityMode: 'card_id',
      canWriteBack: true,
      nowMs: 6000,
      generateCardId: genId,
    });
    expect(res4.stats.restored).toBe(1);
    expect(res4.events.map((e) => e.type)).toEqual(['NoteRestored']);
    applyEvents(state, res4.events);

    expect(state.notes.get(schoolNoteId)?.archived).toBe(false);
    expect(state.cards.get(schoolCardId)?.schedule.reps).toBe(1);
  });

  it('guards Card ID batchUpdate against concurrent row sorts, edits, and other devices racing', () => {
    const { state, factory, deckId } = makeDeckState();
    let seq = 0;
    const initialGrid = [
      ['Word', 'Meaning', 'Card ID'],
      ['하나', 'one', ''],
      ['둘', 'two', ''],
      ['셋', 'three', ''],
    ];

    const diff = diffTabularSource({
      deckId,
      noteType: KO_NOTE_TYPE,
      state,
      eventFactory: factory,
      grid: initialGrid,
      identityMode: 'card_id',
      canWriteBack: true,
      generateCardId: () => `id-${++seq}`,
    });
    expect(diff.writeBackPlan.cells).toHaveLength(3);

    // Simulate concurrent activity before batchUpdate:
    // - Row 2: unchanged & still empty -> SAFE
    // - Row 3: another device already wrote "other-device-id" -> SKIPPED (card_id_changed)
    // - Row 4: user edited meaning "three" -> "3" -> SKIPPED (content_changed)
    const reReadGrid = [
      ['Word', 'Meaning', 'Card ID'],
      ['하나', 'one', ''],
      ['둘', 'two', 'other-device-id'],
      ['셋', '3', ''],
    ];

    const guarded = filterSafeWriteBackCells(diff.writeBackPlan, reReadGrid, KO_NOTE_TYPE);
    expect(guarded.safeCells.map((c) => c.a1)).toEqual(['C2']);
    expect(guarded.skippedCells).toHaveLength(2);
    expect(guarded.skippedCells.map((s) => s.reason)).toEqual([
      'card_id_changed',
      'content_changed',
    ]);

    // Serialize local CSV write-back cleanly
    const csv = applyCardIdsToGridAndSerialize(reReadGrid, ',', guarded, diff.writeBackPlan);
    expect(csv).toContain('하나,one,id-1');
    expect(csv).toContain('둘,two,other-device-id');
  });

  it('skips rows missing Card ID on read-only shared sheets with actionable warning', () => {
    const { state, factory, deckId } = makeDeckState();
    const res = diffTabularSource({
      deckId,
      noteType: KO_NOTE_TYPE,
      state,
      eventFactory: factory,
      grid: [
        ['Word', 'Meaning', 'Card ID'],
        ['감사', 'gratitude', 'owner-id-1'],
        ['사랑', 'love', ''],
      ],
      identityMode: 'card_id',
      canWriteBack: false,
    });
    expect(res.stats.added).toBe(1);
    expect(res.stats.skipped).toBe(1);
    expect(res.writeBackPlan.cells).toHaveLength(0);
    expect(res.warnings.some((w) => w.code === 'missing_card_id_readonly')).toBe(true);
  });

  it('matches read-only .xlsx rows by sortKey and supports rename reconciliation preserving reviews', () => {
    const { state, factory, deckId } = makeDeckState('deck-xlsx', JA_NOTE_TYPE.id);

    const res1 = diffTabularSource({
      deckId,
      noteType: JA_NOTE_TYPE,
      state,
      eventFactory: factory,
      grid: [
        ['Word', 'Reading', 'Meaning'],
        ['食べる', 'たべる', 'to eat'],
        ['飲む', 'のむ', 'to drink'],
      ],
      identityMode: 'sort_key',
      canWriteBack: false,
      nowMs: 1000,
    });
    applyEvents(state, res1.events);

    const eatNoteId = deriveNoteId(deckId, 'sortkey:食べる');
    const eatCardId = deriveCardId(eatNoteId, 'layout:vocab-ja:recognition', 0);
    applyEvents(state, [
      factory.create(
        'ReviewRecorded',
        {
          review_id: 'rev-ja-1',
          card_id: eatCardId,
          rating: 4,
          reviewed_at: 2000,
          tz_offset: 0,
          duration_ms: 800,
          answer_mode: 'flip',
          fsrs_params_version: 0,
          resulting_due_at: 500_000,
        },
        2000,
      ),
    ]);
    expect(state.cards.get(eatCardId)?.schedule.reps).toBe(1);

    // User renames "食べる" -> "食べます" in Excel
    const renamedGrid = [
      ['Word', 'Reading', 'Meaning'],
      ['食べます', 'たべます', 'to eat (polite)'],
      ['飲む', 'のむ', 'to drink'],
    ];

    // First scan without renameMap surfaces reconciliation candidates
    const probe = diffTabularSource({
      deckId,
      noteType: JA_NOTE_TYPE,
      state,
      eventFactory: factory,
      grid: renamedGrid,
      identityMode: 'sort_key',
      canWriteBack: false,
      nowMs: 3000,
    });
    expect(probe.reconciliationCandidates?.missingNotes[0]?.noteId).toBe(eatNoteId);
    expect(probe.reconciliationCandidates?.addedRows[0]?.sortKey).toBe('食べます');

    // Re-running with user-confirmed renameMap preserves eatNoteId and its FSRS review history!
    const reconciled = diffTabularSource({
      deckId,
      noteType: JA_NOTE_TYPE,
      state,
      eventFactory: factory,
      grid: renamedGrid,
      identityMode: 'sort_key',
      canWriteBack: false,
      renameMap: { [eatNoteId]: '食べます' },
      nowMs: 3000,
    });
    expect(reconciled.reconciliationCandidates).toBeUndefined();
    expect(reconciled.stats.archived).toBe(0);
    expect(reconciled.stats.updated).toBe(1);
    applyEvents(state, reconciled.events);

    expect(state.notes.get(eatNoteId)?.fields['word']).toBe('食べます');
    expect(state.notes.get(eatNoteId)?.source_key).toBe('食べます');
    expect(state.cards.get(eatCardId)?.schedule.reps).toBe(1);
  });
});

describe('@flash/core/sources — Markdown Page normalizer & §13 raw HTML protection', () => {
  it('strips raw HTML and unsafe URLs while preserving fenced & inline code blocks', () => {
    const md = [
      '---',
      'title: Particles Guide',
      'lang: ja',
      'tags: [grammar, n5]',
      '---',
      '# Particles',
      '',
      'Safe text with <script>alert("xss")</script><b>bold</b> and <!-- secret --> comment.',
      'Bad link [click](javascript:alert(1)) and good [docs](https://example.com/guide).',
      'Inline code keeps `<script>ok</script>` verbatim.',
      '',
      '```html',
      '<div onclick="x">example code</div>',
      '```',
    ].join('\n');

    const { state, factory } = makeDeckState();
    const res = normalizeMarkdownPage({
      sourceKey: 'gdoc:doc-123',
      fallbackTitle: 'Fallback',
      rawMarkdown: md,
      source: { kind: 'google_docs', external_id: 'doc-123' },
      state,
      eventFactory: factory,
      nowMs: 1000,
    });

    expect(res.title).toBe('Particles Guide');
    expect(res.changed).toBe(true);
    expect(res.events).toHaveLength(1);
    expect(res.warnings.map((w) => w.code)).toContain('raw_html_stripped');
    expect(res.warnings.map((w) => w.code)).toContain('unsafe_url_stripped');

    applyEvents(state, res.events);
    const page = state.pages.get(res.pageId);
    expect(page).toBeDefined();
    if (!page) return;
    expect(page.markdown).not.toContain('alert("xss")');
    expect(page.markdown).not.toContain('<b>');
    expect(page.markdown).not.toContain('javascript:');
    expect(page.markdown).toContain('`<script>ok</script>`');
    expect(page.markdown).toContain('<div onclick="x">example code</div>');
    expect(page.markdown).toContain('(https://example.com/guide)');

    // Second run with identical content emits 0 events
    const res2 = normalizeMarkdownPage({
      sourceKey: 'gdoc:doc-123',
      fallbackTitle: 'Fallback',
      rawMarkdown: md,
      source: { kind: 'google_docs', external_id: 'doc-123' },
      state,
      eventFactory: factory,
      nowMs: 2000,
    });
    expect(res2.changed).toBe(false);
    expect(res2.events).toHaveLength(0);
  });

  it('throws PageSecurityError in strict reject mode', () => {
    expect(() =>
      sanitizePageMarkdown('Hello <img src=x onerror=alert(1)>', { mode: 'reject' }),
    ).toThrow(PageSecurityError);
  });
});

describe('@flash/core/sources — Family Library catalog & .flashpkg upgrade with pages/media', () => {
  it('validates catalog URLs, rejects duplicates/http, and compares versions', () => {
    expect(assertSafeHttpsUrl('HTTPS://Example.com/pack.flashpkg')).toBe(
      'https://Example.com/pack.flashpkg',
    );
    expect(() => assertSafeHttpsUrl('http://example.com/pack.flashpkg')).toThrow(
      CatalogValidationError,
    );
    expect(comparePackageVersions('1.10.0', '1.2.0')).toBeGreaterThan(0);
    expect(comparePackageVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);

    const cat = parseAndValidateFamilyCatalog(
      JSON.stringify({
        format_version: 1,
        name: 'Family',
        packages: [
          {
            package_id: 'pkg:a',
            title: 'Pack A',
            url: 'https://raw.githubusercontent.com/org/repo/main/a.flashpkg',
            version: '1.0.0',
          },
        ],
      }),
    );
    expect(cat.packages).toHaveLength(1);
  });

  it('imports pages & media from .flashpkg and archives/restores notes on upgrade preserving reviews', () => {
    const imgBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const imgHash = sha256Hex(imgBytes);

    const buildPkg = (
      version: string,
      notes: Array<{ id: string; word: string; meaning: string }>,
    ) =>
      zipSync({
        'manifest.json': encodeUtf8(
          JSON.stringify({
            package_id: 'pkg:sub-ko',
            name: 'Sub KO',
            version,
            format_version: 1,
            languages: ['ko', 'en'],
            decks: [
              {
                id: 'deck-ko',
                name: 'Sub KO',
                file: 'decks/ko.jsonl',
                note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
                language: 'ko',
              },
            ],
          }),
        ),
        'decks/ko.jsonl': encodeUtf8(
          notes
            .map((n) => JSON.stringify({ id: n.id, fields: { word: n.word, meaning: n.meaning } }))
            .join('\n') + '\n',
        ),
        'pages/intro.md': encodeUtf8('# Intro\nWelcome <script>bad()</script>'),
        [`media/${imgHash}.png`]: imgBytes,
      });

    const state = createEmptyState();
    const factory = createEventFactory('dev-1', 0, createHlcState('dev-1', 1000));

    // Import v1.0.0
    const v1 = importFlashpkg(
      buildPkg('1.0.0', [
        { id: 'n1', word: '물', meaning: 'water' },
        { id: 'n2', word: '불', meaning: 'fire' },
      ]),
      state,
      factory,
      {
        nowMs: 1000,
        sourceOverride: { kind: 'package_url', uri: 'https://example.com/sub-ko.flashpkg' },
        archiveRemovedOnUpgrade: true,
      },
    );
    expect(v1.pagesImported).toBe(1);
    expect(v1.extractedMedia).toHaveLength(1);
    expect(v1.warnings.some((w) => w.code === 'raw_html_stripped')).toBe(true);
    applyEvents(state, v1.events);

    const deck = [...state.decks.values()][0];
    expect(deck).toBeDefined();
    if (!deck) return;
    expect(deck.source?.kind).toBe('package_url');
    const n1Id = deriveNoteId(deck.id, 'n1');
    const n1CardId = deriveCardId(n1Id, 'layout:vocab-ko:recognition', 0);

    // Review n1
    applyEvents(state, [
      factory.create(
        'ReviewRecorded',
        {
          review_id: 'rev-sub-1',
          card_id: n1CardId,
          rating: 3,
          reviewed_at: 2000,
          tz_offset: 0,
          duration_ms: 500,
          answer_mode: 'flip',
          fsrs_params_version: 0,
          resulting_due_at: 86_400_000,
        },
        2000,
      ),
    ]);

    // Upgrade to v2.0.0: n1 updated, n2 removed -> archived, n1 review preserved!
    const v2 = importFlashpkg(
      buildPkg('2.0.0', [{ id: 'n1', word: '물', meaning: 'water (H2O)' }]),
      state,
      factory,
      {
        nowMs: 3000,
        sourceOverride: { kind: 'package_url', uri: 'https://example.com/sub-ko.flashpkg' },
        archiveRemovedOnUpgrade: true,
      },
    );
    applyEvents(state, v2.events);
    expect(state.notes.get(n1Id)?.fields['meaning']).toBe('water (H2O)');
    expect(state.notes.get(deriveNoteId(deck.id, 'n2'))?.archived).toBe(true);
    expect(state.cards.get(n1CardId)?.schedule.reps).toBe(1);
  });
});

describe('@flash/core/sources — fast-check property tests', () => {
  it('arbitrary sheet edits, reorders, deletes, and restores preserve exact active notes and prior FSRS reviews', () => {
    const rowArb = fc.record({
      cardId: fc.constantFrom('k1', 'k2', 'k3', 'k4', 'k5'),
      word: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0),
      meaning: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
    });

    fc.assert(
      fc.property(
        fc.array(
          fc.uniqueArray(rowArb, { selector: (r) => r.cardId, minLength: 0, maxLength: 5 }),
          {
            minLength: 2,
            maxLength: 8,
          },
        ),
        (snapshots) => {
          const { state, factory, deckId } = makeDeckState();
          const reviewedCardIds = new Set<string>();
          let now = 10_000;

          for (const rows of snapshots) {
            now += 1000;
            const grid: string[][] = [['Word', 'Meaning', 'Card ID']];
            for (const r of rows) {
              grid.push([r.word, r.meaning, r.cardId]);
            }
            const res = diffTabularSource({
              deckId,
              noteType: KO_NOTE_TYPE,
              state,
              eventFactory: factory,
              grid,
              identityMode: 'card_id',
              canWriteBack: true,
              nowMs: now,
            });
            applyEvents(state, res.events);

            // Review every newly seen card once
            for (const r of rows) {
              const cardId = deriveCardId(
                deriveNoteId(deckId, r.cardId),
                'layout:vocab-ko:recognition',
                0,
              );
              if (!reviewedCardIds.has(cardId) && state.cards.has(cardId)) {
                reviewedCardIds.add(cardId);
                now += 100;
                applyEvents(state, [
                  factory.create(
                    'ReviewRecorded',
                    {
                      review_id: `rev-${cardId}`,
                      card_id: cardId,
                      rating: 3,
                      reviewed_at: now,
                      tz_offset: 0,
                      duration_ms: 500,
                      answer_mode: 'flip',
                      fsrs_params_version: 0,
                      resulting_due_at: now + 86_400_000,
                    },
                    now,
                  ),
                ]);
              }
            }

            // Assert exact active note set and intact review reps
            const activeSourceKeys = [...state.notes.values()]
              .filter((n) => n.deck_id === deckId && !n.archived)
              .map((n) => n.source_key)
              .sort();
            const expectedKeys = rows.map((r) => r.cardId).sort();
            expect(activeSourceKeys).toEqual(expectedKeys);

            for (const r of rows) {
              const cardId = deriveCardId(
                deriveNoteId(deckId, r.cardId),
                'layout:vocab-ko:recognition',
                0,
              );
              expect(state.cards.get(cardId)?.schedule.reps).toBe(1);
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('filterSafeWriteBackCells never approves writing to a row whose content or Card ID changed', () => {
    const wordArb = fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim().length > 0);
    fc.assert(
      fc.property(
        fc.array(fc.tuple(wordArb, wordArb), { minLength: 1, maxLength: 6 }),
        fc.array(fc.tuple(wordArb, wordArb, fc.constantFrom('', 'raced-id')), {
          minLength: 1,
          maxLength: 6,
        }),
        (initialRows, reReadRows) => {
          const { state, factory, deckId } = makeDeckState();
          const grid1 = [
            ['Word', 'Meaning', 'Card ID'],
            ...initialRows.map(([w, m]) => [w, m, '']),
          ];
          const diff = diffTabularSource({
            deckId,
            noteType: KO_NOTE_TYPE,
            state,
            eventFactory: factory,
            grid: grid1,
            identityMode: 'card_id',
            canWriteBack: true,
          });

          const grid2 = [['Word', 'Meaning', 'Card ID'], ...reReadRows];
          const guarded = filterSafeWriteBackCells(diff.writeBackPlan, grid2, KO_NOTE_TYPE);

          for (const cell of guarded.safeCells) {
            const origRow = grid1[cell.rowNumber - 1];
            const nextRow = grid2[cell.rowNumber - 1];
            expect(origRow).toBeDefined();
            expect(nextRow).toBeDefined();
            expect((nextRow?.[0] ?? '').trim()).toBe((origRow?.[0] ?? '').trim());
            expect((nextRow?.[1] ?? '').trim()).toBe((origRow?.[1] ?? '').trim());
            expect((nextRow?.[2] ?? '').trim()).toBe('');
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
