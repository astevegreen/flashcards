import { describe, expect, it } from 'vitest';
import { applyRubyDisplay, parseRuby, type RubyDisplay } from '../src/parsers/ruby.ts';
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

  it('mixed filters on one layout keep both', () => {
    const p = plan('{{kana:Reading}}{{kanji:Expression}}', '{{Meaning}}');
    expect(p.layouts[0]?.layout.ruby_display).toBeUndefined();
    const q = plan('{{kana:Reading}}', '{{Reading}}');
    expect(q.layouts[0]?.layout.ruby_display).toBeUndefined();
    const r = plan('{{furigana:Reading}}', '{{Meaning}}');
    expect(r.layouts[0]?.layout.ruby_display).toBeUndefined();
  });
});
