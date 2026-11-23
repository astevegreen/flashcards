import { describe, expect, it } from 'vitest';
import {
  deriveActiveLanguages,
  isLanguageActive,
  isLanguageFeatureActive,
  normalizeLanguage,
} from '../src/languages/active-languages.ts';

describe('normalizeLanguage', () => {
  it('maps tags to app codes', () => {
    expect(normalizeLanguage('ja-JP')).toBe('ja');
    expect(normalizeLanguage(' KO ')).toBe('ko');
    expect(normalizeLanguage('zh')).toBe('zh-Hans');
    expect(normalizeLanguage('zh_CN')).toBe('zh-Hans');
    expect(normalizeLanguage('zh-Hans')).toBe('zh-Hans');
    expect(normalizeLanguage('')).toBe('');
  });
});

describe('deriveActiveLanguages', () => {
  it('is empty with no decks and no onboarding choice', () => {
    expect(deriveActiveLanguages([])).toEqual([]);
  });

  it('collects deck languages, de-duplicated and sorted', () => {
    expect(
      deriveActiveLanguages([{ language: 'ko' }, { language: 'ja' }, { language: 'ko' }]),
    ).toEqual(['ja', 'ko']);
  });

  it('adds the onboarding choice even with no decks', () => {
    expect(deriveActiveLanguages([], 'ko')).toEqual(['ko']);
    expect(deriveActiveLanguages([{ language: 'ja' }], 'ko')).toEqual(['ja', 'ko']);
  });

  it('ignores blank languages and accepts any iterable (a Map.values())', () => {
    const decks = new Map([
      ['a', { language: 'zh' }],
      ['b', { language: '  ' }],
    ]);
    expect(deriveActiveLanguages(decks.values(), undefined)).toEqual(['zh-Hans']);
  });

  it('is order-independent', () => {
    const a = deriveActiveLanguages([{ language: 'en' }, { language: 'ja' }], 'ko');
    const b = deriveActiveLanguages([{ language: 'ja' }, { language: 'en' }], 'ko');
    expect(a).toEqual(b);
  });
});

describe('isLanguageFeatureActive', () => {
  it('shows everything when no language is known', () => {
    expect(isLanguageFeatureActive([], 'furigana')).toBe(true);
    expect(isLanguageActive([], 'ja')).toBe(true);
  });

  it('a Korean-only collection hides furigana, pinyin and tones but keeps Hanja and CJK tools', () => {
    const active = ['ko'];
    expect(isLanguageFeatureActive(active, 'furigana')).toBe(false);
    expect(isLanguageFeatureActive(active, 'kanaImport')).toBe(false);
    expect(isLanguageFeatureActive(active, 'pinyin')).toBe(false);
    expect(isLanguageFeatureActive(active, 'tones')).toBe(false);
    expect(isLanguageFeatureActive(active, 'hanja')).toBe(true);
    expect(isLanguageFeatureActive(active, 'strokeOrder')).toBe(true);
    expect(isLanguageFeatureActive(active, 'handwriting')).toBe(true);
  });

  it('adding Japanese brings furigana back', () => {
    const active = deriveActiveLanguages([{ language: 'ko' }, { language: 'ja' }]);
    expect(isLanguageFeatureActive(active, 'furigana')).toBe(true);
    expect(isLanguageFeatureActive(active, 'pinyin')).toBe(false);
  });

  it('an English-only collection has no CJK tools', () => {
    const active = ['en'];
    expect(isLanguageFeatureActive(active, 'handwriting')).toBe(false);
    expect(isLanguageFeatureActive(active, 'strokeOrder')).toBe(false);
    expect(isLanguageActive(active, 'ko')).toBe(false);
    expect(isLanguageActive(active, 'en')).toBe(true);
  });
});
