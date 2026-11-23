import { describe, expect, it } from 'vitest';
import { normalizeTtsText } from '../src/audio/tts.ts';
import { applyEvents, createEmptyState, createEventFactory } from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import { BUILTIN_LAYOUTS, BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import { expandAnswerCandidates, matchTypedAnswer } from '../src/study/answer-match.ts';
import { applyRubyDisplay, parseRuby, stripRuby } from '../src/parsers/ruby.ts';
import type { Layout, RubyDisplay } from '../src/model/types.ts';
import { planAnkiModel } from '../src/import/anki/model-plan.ts';
import { extractDrawableCharacters } from '../src/drawing/grading.ts';
import { generateChoiceOptions } from '../src/study/choice.ts';
import { noteMatchesSearchText } from '../src/tags/browse.ts';
import { deriveCardId, deriveNoteId } from '../src/ids.ts';
import type { AnkiModel, AnkiNote } from '../src/import/anki/types.ts';

const render = (input: string, mode: RubyDisplay | undefined): string =>
  applyRubyDisplay(parseRuby(input), mode)
    .map((s) => (s.type === 'ruby' ? `<${s.base}|${s.reading}>` : s.value))
    .join('');

// Golden table: [input, both, readings, bases]
const GOLDEN: Array<[string, string, string, string]> = [
  ['日本語[にほんご]を話す', '<日本語|にほんご>を話す', 'にほんごを話す', '日本語を話す'],
  ['{食べる|たべる}', '<食べる|たべる>', 'たべる', '食べる'],
  ['{日本|に|ほん}', '<日|に><本|ほん>', 'にほん', '日本'],
  ['私[わたし]は 日本[にほん]', '<私|わたし>は <日本|にほん>', 'わたしは にほん', '私は 日本'],
  [
    'word [formal] test[abc]',
    'word [formal] test[abc]',
    'word [formal] test[abc]',
    'word [formal] test[abc]',
  ],
  ['', '', '', ''],
];

describe('applyRubyDisplay golden renders', () => {
  for (const [input, both, readings, bases] of GOLDEN) {
    it(`renders ${JSON.stringify(input)}`, () => {
      expect(render(input, undefined)).toBe(both);
      expect(render(input, 'both')).toBe(both);
      expect(render(input, 'readings')).toBe(readings);
      expect(render(input, 'bases')).toBe(bases);
    });
  }

  it('merges the text a reduced ruby leaves next to plain text into one segment', () => {
    expect(applyRubyDisplay(parseRuby('a漢[かん]b'), 'bases')).toEqual([
      { type: 'text', value: 'a漢b' },
    ]);
  });
});

function model(qfmt: string, afmt: string): AnkiModel {
  return {
    id: '1',
    name: 'M',
    kind: 'standard',
    fields: [
      { ord: 0, name: 'Expression' },
      { ord: 1, name: 'Reading' },
      { ord: 2, name: 'Meaning' },
    ],
    templates: [{ ord: 0, name: 'Card 1', qfmt, afmt }],
  } as unknown as AnkiModel;
}

const NOTE = {
  fields: ['日本語[にほんご]', ' 私[わたし]は', 'x'],
} as unknown as AnkiNote;

/** Plans a model whose first card is (q, a); `second` adds Card 2 as [q, a]. */
function plan(qfmt: string, afmt: string, second?: [string, string]) {
  const m = model(qfmt, afmt);
  if (second) {
    m.templates.push({ ord: 1, name: 'Card 2', qfmt: second[0], afmt: second[1] });
  }
  return planAnkiModel(m, [NOTE], {
    templateOrdsWithCards: new Set(second ? [0, 1] : [0]),
    collectionUsesKana: true,
    isUsableMedia: () => false,
  });
}

describe('Anki import keeps full ruby and flags the layout', () => {
  it('kana: only -> readings flag, text keeps the ruby', () => {
    const p = plan('{{kana:Reading}}', '{{Meaning}}');
    expect(p.layouts[0]?.layout.ruby_display).toBe('readings');
    expect(p.notes[0]?.texts[1]?.text).toBe('私[わたし]は');
  });

  it('kanji: only -> bases flag', () => {
    const p = plan('{{kanji:Expression}}', '{{Meaning}}');
    expect(p.layouts[0]?.layout.ruby_display).toBe('bases');
    expect(p.notes[0]?.texts[0]?.text).toBe('日本語[にほんご]');
  });

  it('a field shown through kana: and kanji: on different layouts keeps ruby and a flag per layout', () => {
    const p = plan('{{kana:Reading}}', '{{Meaning}}', ['{{kanji:Reading}}', '{{Meaning}}']);
    expect(p.layouts.map((l) => l.layout.ruby_display)).toEqual(['readings', 'bases']);
    expect(p.notes[0]?.texts[1]?.text).toBe('私[わたし]は');
  });

  it('a layout mixing a kana: field and a kanji: field reduces each at import (old behaviour)', () => {
    const p = plan('{{kana:Reading}}{{kanji:Expression}}', '{{Meaning}}');
    expect(p.layouts[0]?.layout.ruby_display).toBeUndefined();
    expect(p.notes[0]?.texts[0]?.text).toBe('日本語');
    expect(p.notes[0]?.texts[1]?.text).toBe('わたしは');
  });

  it('a field also shown plain, or through furigana:, keeps both', () => {
    expect(plan('{{kana:Reading}}', '{{Reading}}').layouts[0]?.layout.ruby_display).toBeUndefined();
    expect(
      plan('{{furigana:Reading}}', '{{Meaning}}').layouts[0]?.layout.ruby_display,
    ).toBeUndefined();
  });
});

describe('typed answers are not turned into the other half of the ruby', () => {
  it('a typed field shown through kana: elsewhere stays reduced to the reading', () => {
    const p = plan('{{kana:Reading}}', '{{Meaning}}', [
      '{{kanji:Expression}}{{type:Reading}}',
      '{{Meaning}}',
    ]);
    expect(p.notes[0]?.texts[1]?.text).toBe('わたしは');
    expect(p.layouts[1]?.layout.ruby_display).toBe('bases');
    expect(p.layouts[1]?.layout.answer_mode).toBe('typed');
  });

  it('same with a meaning-only prompt: the typed reading stays kana', () => {
    const p = plan('{{kana:Reading}}', '{{Meaning}}', [
      '{{Meaning}}{{type:Reading}}',
      '{{Meaning}}',
    ]);
    expect(p.notes[0]?.texts[1]?.text).toBe('わたしは');
  });
});

describe('stripRuby with a display flag', () => {
  it('keeps bases by default and readings for the readings flag', () => {
    expect(stripRuby('日本語[にほんご]を{食べる|たべる}')).toBe('日本語を食べる');
    expect(stripRuby('日本語[にほんご]を{食べる|たべる}', 'bases')).toBe('日本語を食べる');
    expect(stripRuby('日本語[にほんご]を{食べる|たべる}', 'readings')).toBe('にほんごをたべる');
  });
});

describe('flag-aware consumers', () => {
  it('typed answers match the readings on a readings layout', () => {
    const opts = { lang: 'ja' };
    expect(
      matchTypedAnswer('にほん', '日本[にほん]', { ...opts, rubyDisplay: 'readings' }).correct,
    ).toBe(true);
    expect(expandAnswerCandidates('日本[にほん]', 'readings')).toEqual(['にほん', '日本']);
  });

  it('TTS speaks the readings only on a readings layout', () => {
    expect(normalizeTtsText('日本[にほん]')).toBe('日本');
    expect(normalizeTtsText('日本[にほん]', 'readings')).toBe('にほん');
  });

  it('exports and re-imports ruby_display through .flashpkg', () => {
    const t0 = Date.UTC(2026, 5, 2, 10, 0, 0);
    const state = createEmptyState();
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    applyEvents(state, [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Ruby Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: t0,
        },
        t0,
      ),
      factory.create(
        'LayoutChanged',
        {
          layout: {
            ...(BUILTIN_LAYOUTS[0] as Layout),
            id: 'layout:custom:ruby',
            note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
            ruby_display: 'readings',
          },
        },
        t0 + 1,
      ),
    ]);
    const zip = exportFlashpkg(state, { name: 'RubyPkg' });
    const fresh = createEmptyState();
    const f2 = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 100));
    applyEvents(fresh, importFlashpkg(zip, fresh, f2, { nowMs: t0 + 100 }).events);
    expect(fresh.layouts.get('layout:custom:ruby')?.ruby_display).toBe('readings');
  });
});

describe('typed answers follow the ruby the card shows (matchTypedAnswer)', () => {
  const ja = { lang: 'ja' };
  const RAW = '私[わたし]は日本[にほん]';

  it('no ruby: plain answers match as before', () => {
    expect(matchTypedAnswer('ねこ', 'ねこ', ja).correct).toBe(true);
    expect(matchTypedAnswer('neko', 'ねこ', { ...ja, rubyDisplay: 'readings' }).correct).toBe(true);
    expect(matchTypedAnswer('いぬ', 'ねこ', { ...ja, rubyDisplay: 'bases' }).correct).toBe(false);
    expect(expandAnswerCandidates('cat; kitten', 'readings')).toEqual(['cat', 'kitten']);
  });

  it('both (or no flag): the full ruby is shown, so bases and readings both count', () => {
    for (const opts of [ja, { ...ja, rubyDisplay: 'both' as const }]) {
      expect(matchTypedAnswer('私は日本', RAW, opts).correct).toBe(true);
      expect(matchTypedAnswer('わたしはにほん', RAW, opts).correct).toBe(true);
      expect(matchTypedAnswer('watashihanihon', RAW, opts).correct).toBe(true);
      expect(matchTypedAnswer('わたしはにっぽん', RAW, opts).correct).toBe(false);
    }
    expect(expandAnswerCandidates(RAW)).toEqual(['私は日本', 'わたしはにほん']);
  });

  it('readings: the readings count, and so do the bases', () => {
    const opts = { ...ja, rubyDisplay: 'readings' as const };
    expect(matchTypedAnswer('わたしはにほん', RAW, opts).correct).toBe(true);
    expect(matchTypedAnswer('私は日本', RAW, opts).correct).toBe(true);
    const wrong = matchTypedAnswer('わたしはにほ', RAW, opts);
    expect(wrong.correct).toBe(false);
    expect(wrong.matchedCandidate).toBe('わたしはにほん');
  });

  it('bases: only the bases count (the readings are hidden)', () => {
    const opts = { ...ja, rubyDisplay: 'bases' as const };
    expect(matchTypedAnswer('私は日本', RAW, opts).correct).toBe(true);
    expect(matchTypedAnswer('わたしはにほん', RAW, opts).correct).toBe(false);
    expect(expandAnswerCandidates(RAW, 'bases')).toEqual(['私は日本']);
  });

  it('alternates and pinyin ruby reduce per alternate', () => {
    expect(expandAnswerCandidates('{食べる|たべる}; {喰う|くう}')).toEqual([
      '食べる',
      '喰う',
      'たべる',
      'くう',
    ]);
    const zh = { lang: 'zh-Hans' };
    expect(matchTypedAnswer('中文', '中文[zhōngwén]', zh).correct).toBe(true);
    expect(matchTypedAnswer('zhong1wen2', '中文[zhōngwén]', zh).correct).toBe(true);
    expect(
      matchTypedAnswer('zhong1wen2', '中文[zhōngwén]', { ...zh, rubyDisplay: 'bases' }).correct,
    ).toBe(false);
  });
});

describe('draw grading follows the ruby flag', () => {
  it('a readings layout draws the readings, any other the bases', () => {
    expect(extractDrawableCharacters('日本[にほん]', 'ja')).toEqual(['日', '本']);
    expect(extractDrawableCharacters('日本[にほん]', 'ja', { rubyDisplay: 'bases' })).toEqual([
      '日',
      '本',
    ]);
    expect(extractDrawableCharacters('日本[にほん]', 'ja', { rubyDisplay: 'readings' })).toEqual([
      'に',
      'ほ',
      'ん',
    ]);
  });
});

describe('choice dedupe follows the ruby flag', () => {
  const t0 = Date.UTC(2026, 5, 2, 10, 0, 0);
  const DECK = 'deck-homophones';
  const LAYOUT = 'layout:custom:homophones';
  const WORDS = ['橋[はし]', '箸[はし]', '端[はし]', '雨[あめ]', '飴[あめ]', '山[やま]', '川[かわ]'];

  function homophoneState(rubyDisplay: RubyDisplay | undefined) {
    const state = createEmptyState();
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    applyEvents(state, [
      factory.create(
        'DeckCreated',
        {
          deck_id: DECK,
          name: 'Homophones',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ja',
          created_at: t0,
        },
        t0,
      ),
      factory.create(
        'LayoutChanged',
        {
          layout: {
            ...(BUILTIN_LAYOUTS[0] as Layout),
            id: LAYOUT,
            note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
            answer_mode: 'choice',
            answer_field: 'word',
            ...(rubyDisplay ? { ruby_display: rubyDisplay } : {}),
          },
        },
        t0 + 1,
      ),
      ...WORDS.map((word, i) =>
        factory.create(
          'NoteUpserted',
          {
            note_id: deriveNoteId(DECK, `w${i}`),
            deck_id: DECK,
            source_key: `w${i}`,
            fields: { word, meaning: `m${i}` },
            tags: [],
            created_order: i,
          },
          t0 + 2 + i,
        ),
      ),
    ]);
    return state;
  }

  function shownOptions(rubyDisplay: RubyDisplay): string[] {
    const state = homophoneState(rubyDisplay);
    const card = state.cards.get(deriveCardId(deriveNoteId(DECK, 'w0'), LAYOUT, 0));
    expect(card).toBeDefined();
    if (!card) return [];
    return generateChoiceOptions(state, card, 100).options.map((o) =>
      stripRuby(o.text, rubyDisplay),
    );
  }

  it('a readings layout never offers two options that read the same', () => {
    const texts = shownOptions('readings');
    expect(texts).toHaveLength(4);
    expect(new Set(texts)).toEqual(new Set(['はし', 'あめ', 'やま', 'かわ']));
  });

  it('a bases layout keeps homophones with different bases apart', () => {
    const texts = shownOptions('bases');
    expect(texts).toHaveLength(4);
    expect(new Set(texts).size).toBe(4);
  });
});

describe('Browse search across ruby groups', () => {
  const note = {
    fields: { word: '私[わたし]は日本[にほん]に{住む|すむ}', meaning: 'I live in Japan' },
    tags: [],
  } as unknown as Parameters<typeof noteMatchesSearchText>[0];

  it('matches the concatenated readings and the concatenated bases', () => {
    expect(noteMatchesSearchText(note, 'わたしはにほん')).toBe(true);
    expect(noteMatchesSearchText(note, 'にほんにすむ')).toBe(true);
    expect(noteMatchesSearchText(note, '私は日本')).toBe(true);
    expect(noteMatchesSearchText(note, '日本に住む')).toBe(true);
    expect(noteMatchesSearchText(note, 'にほん')).toBe(true);
  });

  it('does not match a mix of bases and readings or text that is not there', () => {
    expect(noteMatchesSearchText(note, '私はにほん')).toBe(false);
    expect(noteMatchesSearchText(note, 'わたしがにほん')).toBe(false);
  });
});
