import { describe, expect, it } from 'vitest';
import {
  computeCharDiff,
  convertJaRomajiLive,
  matchTypedAnswer,
} from '../src/study/answer-match.ts';

describe('Typed-answer matching engine (§5.2)', () => {
  it('handles universal normalization: NFKC, trim, spaces, case, punctuation, alternates, optional segments', () => {
    const r1 = matchTypedAnswer('  HELLO,   World!! ', 'hello world', { lang: 'en' });
    expect(r1.correct).toBe(true);
    expect(r1.suggestedRating).toBe(3);

    // Full-width ASCII -> NFKC
    const r2 = matchTypedAnswer('ＳＣＨＯＯＬ', 'school', { lang: 'en' });
    expect(r2.correct).toBe(true);

    // Contractions / apostrophes ignored without splitting into two words
    expect(matchTypedAnswer('dont', "don't", { lang: 'en' }).correct).toBe(true);
    expect(matchTypedAnswer('its', "it's", { lang: 'en' }).correct).toBe(true);

    // Alternate answers with ; and |
    expect(matchTypedAnswer('appointment', 'promise; appointment', { lang: 'en' }).correct).toBe(
      true,
    );
    expect(matchTypedAnswer('journey', 'trip | journey', { lang: 'en' }).correct).toBe(true);

    // Optional (...) and （…） segments
    expect(matchTypedAnswer('study', '(to) study', { lang: 'en' }).correct).toBe(true);
    expect(matchTypedAnswer('to study', '(to) study', { lang: 'en' }).correct).toBe(true);
    expect(matchTypedAnswer('study', '（to） study', { lang: 'en' }).correct).toBe(true);

    // Incorrect answer suggests Again (1)
    const wrong = matchTypedAnswer('scool', 'school', { lang: 'en' });
    expect(wrong.correct).toBe(false);
    expect(wrong.suggestedRating).toBe(1);
    expect(wrong.diff).toEqual([
      { op: 'equal', text: 'sc' },
      { op: 'delete', text: 'h' },
      { op: 'equal', text: 'ool' },
    ]);
  });

  it('handles Japanese romaji -> kana, live IME mode, and hiragana/katakana toggle', () => {
    // Romaji input matches hiragana expected
    expect(matchTypedAnswer('tabemasu', 'たべます', { lang: 'ja' }).correct).toBe(true);
    expect(matchTypedAnswer('benkyou', 'べんきょう', { lang: 'ja' }).correct).toBe(true);

    // Live IME conversion keeps trailing single 'n' pending
    expect(convertJaRomajiLive('nihon')).toBe('にほn');
    expect(convertJaRomajiLive('nihonn')).toBe('にほん');
    expect(convertJaRomajiLive('tabemasu')).toBe('たべます');

    // Hiragana <-> Katakana equivalence toggle (including katakana long vowel mark `ー`)
    expect(
      matchTypedAnswer('かたかな', 'カタカナ', { lang: 'ja', jaKanaEquivalent: true }).correct,
    ).toBe(true);
    expect(
      matchTypedAnswer('katakana', 'カタカナ', { lang: 'ja', jaKanaEquivalent: true }).correct,
    ).toBe(true);
    expect(
      matchTypedAnswer('らーめん', 'ラーメン', { lang: 'ja', jaKanaEquivalent: true }).correct,
    ).toBe(true);
    expect(
      matchTypedAnswer('ra-men', 'ラーメン', { lang: 'ja', jaKanaEquivalent: true }).correct,
    ).toBe(true);
    expect(
      matchTypedAnswer('ko-hi-', 'コーヒー', { lang: 'ja', jaKanaEquivalent: true }).correct,
    ).toBe(true);
    expect(
      matchTypedAnswer('かたかな', 'カタカナ', { lang: 'ja', jaKanaEquivalent: false }).correct,
    ).toBe(false);
    expect(
      matchTypedAnswer('カタカナ', 'カタカナ', { lang: 'ja', jaKanaEquivalent: false }).correct,
    ).toBe(true);

    // Strips ruby annotations from expected field automatically
    expect(matchTypedAnswer('日本', '日本[にほん]', { lang: 'ja' }).correct).toBe(true);
  });

  it('handles Mandarin tone marks <-> tone numbers, umlauts, and ignore-tones toggle', () => {
    expect(matchTypedAnswer('ni3 hao3', 'nǐ hǎo', { lang: 'zh-Latn-pinyin' }).correct).toBe(true);
    expect(matchTypedAnswer('nǐ hǎo', 'ni3 hao3', { lang: 'zh-Latn-pinyin' }).correct).toBe(true);
    expect(matchTypedAnswer('ni3hao3', 'nǐ hǎo', { lang: 'zh-Latn-pinyin' }).correct).toBe(true);
    expect(matchTypedAnswer('lv4', 'lǜ', { lang: 'zh-Latn-pinyin' }).correct).toBe(true);
    expect(matchTypedAnswer('nu:3', 'nǚ', { lang: 'zh-Latn-pinyin' }).correct).toBe(true);

    // Wrong tone fails by default
    expect(
      matchTypedAnswer('ni2 hao3', 'nǐ hǎo', { lang: 'zh-Latn-pinyin', zhIgnoreTones: false })
        .correct,
    ).toBe(false);

    // Ignore-tones toggle accepts toneless / different-tone pinyin while preserving ü vs u
    expect(
      matchTypedAnswer('ni hao', 'nǐ hǎo', { lang: 'zh-Latn-pinyin', zhIgnoreTones: true }).correct,
    ).toBe(true);
    expect(
      matchTypedAnswer('lv', 'lǜ', { lang: 'zh-Latn-pinyin', zhIgnoreTones: true }).correct,
    ).toBe(true);
    expect(
      matchTypedAnswer('lu', 'lǜ', { lang: 'zh-Latn-pinyin', zhIgnoreTones: true }).correct,
    ).toBe(false);
  });

  it('handles Korean composed vs decomposed Hangul Jamo NFC equivalence', () => {
    const composed = '한글';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);

    expect(matchTypedAnswer(decomposed, composed, { lang: 'ko' }).correct).toBe(true);
    expect(matchTypedAnswer(composed, decomposed, { lang: 'ko' }).correct).toBe(true);
  });

  it('produces accurate character-level diff ops for insertions, deletions, and substitutions', () => {
    const diff = computeCharDiff('学校', '学好校');
    expect(diff).toEqual([
      { op: 'equal', text: '学' },
      { op: 'insert', text: '好' },
      { op: 'equal', text: '校' },
    ]);
  });
});
