import { describe, expect, it } from 'vitest';
import { formatPinyin, parsePinyin } from '../src/parsers/pinyin.ts';
import { parseRuby, stripRuby } from '../src/parsers/ruby.ts';

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
});
