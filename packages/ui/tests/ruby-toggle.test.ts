import { BUILTIN_LAYOUTS } from '@flash/core';
import { describe, expect, it } from 'vitest';
import { frontRubyHidden, showRubyToggle } from '../src/study/rubyToggle.ts';

const koRecognition = BUILTIN_LAYOUTS.find((l) => l.id === 'layout:vocab-ko:recognition');
const koProduction = BUILTIN_LAYOUTS.find((l) => l.id === 'layout:vocab-ko:production');

describe('Study Ruby toggle (frontRubyHidden)', () => {
  it('the built-in Korean recognition layout hides ruby on the front', () => {
    expect(koRecognition?.hide_furigana_on_front).toBe(true);
    expect(koProduction?.hide_furigana_on_front).toBe(false);
  });

  it('keeps the toggle for a Korean note that stores Hangul-over-Hanja ruby hidden on the front', () => {
    const note = { fields: { word: '학교 (學校[학교])', meaning: 'school' } };
    expect(frontRubyHidden(koRecognition, note)).toBe(true);
    // Korean is not a ruby language, but the stored, hidden reading stays reachable.
    expect(showRubyToggle(false, koRecognition, note)).toBe(true);
  });

  it('no toggle for plain Hanja, or when the layout does not hide ruby on the front', () => {
    expect(showRubyToggle(false, koRecognition, { fields: { word: '학교 (學校)' } })).toBe(false);
    expect(showRubyToggle(false, koProduction, { fields: { meaning: '學校[학교]' } })).toBe(false);
    expect(showRubyToggle(false, undefined, undefined)).toBe(false);
  });

  it('ruby languages (ja, zh) always get the toggle', () => {
    expect(showRubyToggle(true, koRecognition, { fields: { word: '학교' } })).toBe(true);
  });
});
