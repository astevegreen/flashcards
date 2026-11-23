import { describe, expect, it } from 'vitest';
import { normalizeTtsText } from '../src/audio/tts.ts';
import { applyEvents, createEmptyState, createEventFactory } from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import { expandAnswerCandidates, matchTypedAnswer } from '../src/study/answer-match.ts';
import { applyRubyDisplay, parseRuby, stripRuby } from '../src/parsers/ruby.ts';
import type { RubyDisplay } from '../src/model/types.ts';
import { planAnkiModel } from '../src/import/anki/model-plan.ts';
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

function plan(qfmt: string, afmt: string) {
  return planAnkiModel(model(qfmt, afmt), [NOTE], {
    templateOrdsWithCards: new Set([0]),
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
    const m = model('{{kana:Reading}}', '{{Meaning}}');
    m.templates.push({ ord: 1, name: 'Card 2', qfmt: '{{kanji:Reading}}', afmt: '{{Meaning}}' });
    const p = planAnkiModel(m, [NOTE], {
      templateOrdsWithCards: new Set([0, 1]),
      collectionUsesKana: true,
      isUsableMedia: () => false,
    });
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
    const m = model('{{kana:Reading}}', '{{Meaning}}');
    m.templates.push({
      ord: 1,
      name: 'Card 2',
      qfmt: '{{kanji:Expression}}{{type:Reading}}',
      afmt: '{{Meaning}}',
    });
    const p = planAnkiModel(m, [NOTE], {
      templateOrdsWithCards: new Set([0, 1]),
      collectionUsesKana: true,
      isUsableMedia: () => false,
    });
    expect(p.notes[0]?.texts[1]?.text).toBe('わたしは');
    expect(p.layouts[1]?.layout.ruby_display).toBe('bases');
    expect(p.layouts[1]?.layout.answer_mode).toBe('typed');
  });

  it('same with a meaning-only prompt: the typed reading stays kana', () => {
    const m = model('{{kana:Reading}}', '{{Meaning}}');
    m.templates.push({
      ord: 1,
      name: 'Card 2',
      qfmt: '{{Meaning}}{{type:Reading}}',
      afmt: '{{Meaning}}',
    });
    const p = planAnkiModel(m, [NOTE], {
      templateOrdsWithCards: new Set([0, 1]),
      collectionUsesKana: true,
      isUsableMedia: () => false,
    });
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
    expect(matchTypedAnswer('にほん', '日本[にほん]', opts).correct).toBe(false);
    expect(
      matchTypedAnswer('にほん', '日本[にほん]', { ...opts, rubyDisplay: 'readings' }).correct,
    ).toBe(true);
    expect(expandAnswerCandidates('日本[にほん]', 'readings')).toEqual(['にほん']);
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
            id: 'layout:custom:ruby',
            note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
            name: 'Readings',
            front_fields: ['word'],
            reveal_steps: [['meaning']],
            answer_mode: 'flip',
            hide_furigana_on_front: false,
            ruby_display: 'readings',
            enabled: true,
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
