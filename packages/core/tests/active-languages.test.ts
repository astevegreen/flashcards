import { describe, expect, it } from 'vitest';
import { createEventFactory, applyEvents, createEmptyState } from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import {
  deriveActiveLanguages,
  isLanguageActive,
  isLanguageFeatureActive,
  noteTypeLanguages,
  normalizeLanguage,
} from '../src/languages/active-languages.ts';
import { BUILTIN_NOTE_TYPE_IDS, BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';

const noteTypes = new Map(BUILTIN_NOTE_TYPES.map((nt) => [nt.id, nt]));

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

  it('counts the onboarding choice even with no decks', () => {
    expect(deriveActiveLanguages([], 'ko')).toEqual(['ko']);
    expect(deriveActiveLanguages([], 'ja', noteTypes)).toEqual(['ja']);
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

  it('a deck tagged en on a Japanese note type still makes Japanese active', () => {
    const decks = [{ language: 'en', note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA }];
    expect(deriveActiveLanguages(decks)).toEqual(['en']);
    const active = deriveActiveLanguages(decks, undefined, noteTypes);
    expect(active).toContain('ja');
    expect(isLanguageActive(active, 'ja')).toBe(true);
  });

  it('a Korean deck does not pull in English from its meaning field', () => {
    const decks = [{ language: 'ko', note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO }];
    expect(deriveActiveLanguages(decks, undefined, noteTypes)).toEqual(['ko']);
  });

  it('drops romanisation field tags but a Chinese word field counts', () => {
    const type = {
      fields: [
        { lang: 'zh-Latn-pinyin' },
        { lang: 'en', tts: true },
        { lang: 'en' },
        { lang: 'zh-Hans' },
      ],
    };
    expect(noteTypeLanguages(type)).toEqual(['en', 'zh-Hans']);
  });
});

describe('isLanguageFeatureActive', () => {
  it('shows everything when no language is known', () => {
    expect(isLanguageFeatureActive([], 'ruby')).toBe(true);
    expect(isLanguageActive([], 'ja')).toBe(true);
  });

  it('ruby covers ja, ko and zh (Hanja and pinyin ruby), not en', () => {
    expect(isLanguageFeatureActive(['ko'], 'ruby')).toBe(true);
    expect(isLanguageFeatureActive(['zh-Hans'], 'ruby')).toBe(true);
    expect(isLanguageFeatureActive(['ja'], 'ruby')).toBe(true);
    expect(isLanguageFeatureActive(['en'], 'ruby')).toBe(false);
  });

  it('a Korean-only collection hides pinyin and tones but keeps handwriting', () => {
    expect(isLanguageFeatureActive(['ko'], 'pinyin')).toBe(false);
    expect(isLanguageFeatureActive(['ko'], 'tones')).toBe(false);
    expect(isLanguageFeatureActive(['ko'], 'handwriting')).toBe(true);
    expect(isLanguageActive(['ko'], 'ja')).toBe(false);
  });

  it('adding Chinese brings pinyin and tones back', () => {
    const active = deriveActiveLanguages([{ language: 'ko' }, { language: 'zh-Hans' }]);
    expect(isLanguageFeatureActive(active, 'pinyin')).toBe(true);
    expect(isLanguageFeatureActive(active, 'tones')).toBe(true);
  });

  it('an English-only collection has no CJK tools', () => {
    expect(isLanguageFeatureActive(['en'], 'handwriting')).toBe(false);
    expect(isLanguageActive(['en'], 'ko')).toBe(false);
    expect(isLanguageActive(['en'], 'en')).toBe(true);
  });
});

describe('hidden preferences are kept', () => {
  it('a stored zh_ignore_tones value is untouched by which languages are active', () => {
    const state = createEmptyState();
    const factory = createEventFactory('dev', 0, createHlcState('dev', 1000));
    applyEvents(state, [
      factory.create('PreferencesChanged', { preferences: { zh_ignore_tones: true } }, 1000),
    ]);
    const before = JSON.stringify(state.preferences);
    // Chinese inactive (options hidden), then active again (options back).
    expect(isLanguageFeatureActive(deriveActiveLanguages([{ language: 'ko' }]), 'tones')).toBe(
      false,
    );
    expect(state.preferences.zh_ignore_tones).toBe(true);
    expect(isLanguageFeatureActive(deriveActiveLanguages([{ language: 'zh' }]), 'tones')).toBe(
      true,
    );
    expect(JSON.stringify(state.preferences)).toBe(before);
    expect(state.preferences.zh_ignore_tones).toBe(true);
  });
});
