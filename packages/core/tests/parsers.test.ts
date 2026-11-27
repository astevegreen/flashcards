import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { formatPinyin, parsePinyin } from '../src/parsers/pinyin.ts';
import { isHanCodePoint, parseRuby, stripRuby } from '../src/parsers/ruby.ts';
import { convertAnkiRuby } from '../src/import/anki-ruby.ts';

describe('Anki furigana conversion (§6.2)', () => {
  it('turns space-delimited Han bases into strict ruby and mixed bases into explicit ruby', () => {
    expect(convertAnkiRuby('私は 日本語[にほんご]を 勉強[べんきょう]します')).toBe(
      '私は日本語[にほんご]を勉強[べんきょう]します',
    );
    expect(convertAnkiRuby('食べる[たべる]')).toBe('{食べる|たべる}');
    expect(convertAnkiRuby('學[학]교')).toBe('學[학]교');
    expect(parseRuby(convertAnkiRuby('私は 日本語[にほんご]'))).toEqual([
      { type: 'text', value: '私は' },
      { type: 'ruby', base: '日本語', reading: 'にほんご' },
    ]);
  });

  it('leaves non-CJK brackets alone', () => {
    expect(convertAnkiRuby('word [formal]')).toBe('word [formal]');
    expect(convertAnkiRuby('test[abc] and more')).toBe('test[abc] and more');
    expect(convertAnkiRuby('no brackets here')).toBe('no brackets here');
  });

  it('matches the earlier regular-expression rule on any mix of spaces, brackets and scripts', () => {
    // The rule as it was written before the linear scan, kept here only as the reference.
    const ideographicSpace = String.fromCodePoint(0x3000);
    const isKana = (cp: number) => (cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff);
    const reference = (input: string): string =>
      input.replace(
        new RegExp(String.raw`(^|[ ${ideographicSpace}])([^\s[\]{}|]+)\[([^\][]+)\]`, 'gu'),
        (match, lead: string, base: string, reading: string) => {
          const cps = Array.from(base).map((c) => c.codePointAt(0) ?? 0);
          if (!cps.some(isHanCodePoint)) return match;
          if (cps.every(isHanCodePoint)) return `${base}[${reading}]`;
          if (cps.every((cp) => isHanCodePoint(cp) || isKana(cp))) return `{${base}|${reading}}`;
          return `${lead}{${base}|${reading}}`;
        },
      );
    const alphabet = [
      ' ',
      ideographicSpace,
      '[',
      ']',
      '{',
      '}',
      '|',
      '\t',
      '\n',
      'a',
      '!',
      '日',
      '本',
      // Astral Han (CJK Extension B, two UTF-16 code units each).
      String.fromCodePoint(0x20000),
      String.fromCodePoint(0x20b9f),
      'た',
      'ア',
      'ー',
      '학',
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...alphabet), { maxLength: 24 }), (chars) => {
        const input = chars.join('');
        expect(convertAnkiRuby(input)).toBe(reference(input));
      }),
      { numRuns: 3000 },
    );
  });

  it('stays linear on long adversarial imports (unclosed brackets, long space runs)', () => {
    const space = String.fromCodePoint(0x3000);
    const inputs = [
      ` ${`${space}!`.repeat(50_000)}`,
      `日[${' 日['.repeat(50_000)}`,
      `${' 日'.repeat(50_000)}[`,
    ];
    const start = performance.now();
    for (const input of inputs) convertAnkiRuby(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('Ruby parser (§6.2)', () => {
  it('parses strict Han[reading] without space before bracket', () => {
    expect(parseRuby('私の日本[にほん]')).toEqual([
      { type: 'text', value: '私の' },
      { type: 'ruby', base: '日本', reading: 'にほん' },
    ]);
  });

  it('never parses X [Y] when there is a space before bracket', () => {
    expect(parseRuby('word [formal]')).toEqual([{ type: 'text', value: 'word [formal]' }]);
    expect(parseRuby('日本 [にほん]')).toEqual([{ type: 'text', value: '日本 [にほん]' }]);
  });

  it('never parses non-Han base[reading]', () => {
    expect(parseRuby('test[abc]')).toEqual([{ type: 'text', value: 'test[abc]' }]);
    expect(parseRuby('かな[ふりがな]')).toEqual([{ type: 'text', value: 'かな[ふりがな]' }]);
  });

  it('parses Hanja Hangul readings and CJK iteration marks', () => {
    expect(parseRuby('學[학]')).toEqual([{ type: 'ruby', base: '學', reading: '학' }]);
    expect(parseRuby('학교 (學校[학교])')).toEqual([
      { type: 'text', value: '학교 (' },
      { type: 'ruby', base: '學校', reading: '학교' },
      { type: 'text', value: ')' },
    ]);
    expect(parseRuby('人々[ひとびと]')).toEqual([
      { type: 'ruby', base: '人々', reading: 'ひとびと' },
    ]);
    expect(parseRuby('一ヶ月[いっかげつ]')).toEqual([
      { type: 'ruby', base: '一ヶ月', reading: 'いっかげつ' },
    ]);
  });

  it('parses explicit {base|reading} and per-character {日本|に|ほん}', () => {
    expect(parseRuby('{今日|きょう}')).toEqual([{ type: 'ruby', base: '今日', reading: 'きょう' }]);
    expect(parseRuby('{日本|に|ほん}')).toEqual([
      { type: 'ruby', base: '日', reading: 'に' },
      { type: 'ruby', base: '本', reading: 'ほん' },
    ]);
    expect(parseRuby('{かな|reading}')).toEqual([
      { type: 'ruby', base: 'かな', reading: 'reading' },
    ]);
  });

  it('handles edge cases gracefully without throwing', () => {
    expect(parseRuby('')).toEqual([]);
    expect(parseRuby('日本[')).toEqual([{ type: 'text', value: '日本[' }]);
    expect(parseRuby('日本[]')).toEqual([{ type: 'text', value: '日本[]' }]);
    expect(parseRuby('{unclosed|reading')).toEqual([{ type: 'text', value: '{unclosed|reading' }]);
    expect(parseRuby('{|empty}')).toEqual([{ type: 'text', value: '{|empty}' }]);
  });

  it('strips ruby readings cleanly for search/sorting', () => {
    expect(stripRuby('私[わたし]の日本[にほん]の{友達|とも|だち}')).toBe('私の日本の友達');
    expect(stripRuby('word [formal]')).toBe('word [formal]');
  });
});

describe('Pinyin parser (§6.2)', () => {
  it('converts numbered pinyin to tone marks with tone metadata', () => {
    expect(formatPinyin('ni3 hao3')).toBe('nǐ hǎo');
    expect(parsePinyin('ni3 hao3')).toEqual([
      { text: 'nǐ', tone: 3 },
      { text: ' ', tone: 0 },
      { text: 'hǎo', tone: 3 },
    ]);
  });

  it('handles ü variants (v, u:, ü) and neutral tone (5 / 0)', () => {
    expect(formatPinyin('lv4')).toBe('lǜ');
    expect(formatPinyin('lu:4')).toBe('lǜ');
    expect(formatPinyin('lü4')).toBe('lǜ');
    expect(formatPinyin('nv3')).toBe('nǚ');
    expect(formatPinyin('nu:3')).toBe('nǚ');
    expect(parsePinyin('ma5')).toEqual([{ text: 'ma', tone: 5 }]);
    expect(parsePinyin('ma0')).toEqual([{ text: 'ma', tone: 5 }]);
  });

  it('applies standard Hanyu Pinyin vowel placement rules and preserves case', () => {
    expect(formatPinyin('Zhong1guo2')).toBe('Zhōngguó');
    expect(formatPinyin('gou3')).toBe('gǒu');
    expect(formatPinyin('lai2')).toBe('lái');
    expect(formatPinyin('xue2')).toBe('xué');
    expect(formatPinyin('gui4')).toBe('guì');
    expect(formatPinyin('liu2')).toBe('liú');
  });

  it('detects tones on already-accented pinyin and preserves punctuation', () => {
    expect(parsePinyin('nǐ hǎo!')).toEqual([
      { text: 'nǐ', tone: 3 },
      { text: ' ', tone: 0 },
      { text: 'hǎo', tone: 3 },
      { text: '!', tone: 0 },
    ]);
    expect(parsePinyin('')).toEqual([]);
  });

  it('does not corrupt non-pinyin v words or strip digits from consonant-only tokens, and handles u: forms', () => {
    expect(formatPinyin('nǐ hǎo (vs. nín hǎo)')).toBe('nǐ hǎo (vs. nín hǎo)');
    expect(formatPinyin('very good')).toBe('very good');
    expect(formatPinyin('hsk3')).toBe('hsk3');
    expect(parsePinyin('hsk3')).toEqual([{ text: 'hsk3', tone: 0 }]);
    expect(parsePinyin('hsk5')).toEqual([{ text: 'hsk5', tone: 0 }]);
    expect(formatPinyin('u:3')).toBe('ǚ');
    expect(formatPinyin('lu:e')).toBe('lüe');
    expect(formatPinyin('v3')).toBe('ǚ');
  });

  it('leaves a word followed by a digit alone unless the word is a syllable (§11 nit)', () => {
    expect(formatPinyin('Windows1')).toBe('Windows1');
    expect(parsePinyin('Windows11')).toEqual([
      { text: 'Windows1', tone: 0 },
      { text: '1', tone: 0 },
    ]);
    expect(formatPinyin('mp3 player')).toBe('mp3 player');
    expect(formatPinyin('Zhong1guo2 Windows1')).toBe('Zhōngguó Windows1');
    expect(formatPinyin('nar3 er2 shuang1 xiong2 jue2 lve4')).toBe('nǎr ér shuāng xióng jué lüè');
  });
});
