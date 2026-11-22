import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCardTextSize } from '../src/study/cardTextSize.ts';
import { cardTextFitClass, cardTextFitTier, visibleTextLength } from '../src/study/fitText.ts';

const PROMPT_ORDER = ['p1', 'p2', 'p3', 'p4', 'p5 long'];

const textOf = (chars: string[], minLength: number) =>
  fc.array(fc.constantFrom(...chars), { minLength, maxLength: 120 }).map((cs) => cs.join(''));

describe('auto-fit card text (Phase 13)', () => {
  it('counts visible characters, ignoring ruby readings and cloze markup', () => {
    expect(visibleTextLength('學')).toBe(1);
    expect(visibleTextLength('學校[학교]')).toBe(2);
    expect(visibleTextLength('{日本|にほん}')).toBe(2);
    expect(visibleTextLength('私{{c1::は::particle}}学生です')).toBe(6);
    expect(visibleTextLength('  bite   the\nbullet ')).toBe(15);
    // Astral-plane Han (CJK Extension B) counts as one character.
    expect(visibleTextLength('𠀋')).toBe(1);
  });

  it('gives a single Hanja the largest tier and a grammar paragraph the reading tier', () => {
    expect(cardTextFitClass('學')).toBe('card-fit card-fit-p1');
    expect(cardTextFitClass('학교 (學校[학교])')).toBe('card-fit card-fit-p3');
    expect(cardTextFitClass('x'.repeat(200))).toBe('card-fit card-fit-p5 card-fit-long');
    expect(cardTextFitClass('school', 'answer')).toBe('card-fit card-fit-a1');
    expect(cardTextFitClass('y'.repeat(61), 'answer')).toBe('card-fit card-fit-a3 card-fit-long');
    expect(cardTextFitClass('note', 'detail')).toBe('card-fit card-fit-d');
  });

  it('never picks a larger tier for longer text (property)', () => {
    fc.assert(
      fc.property(
        // Markup-free text (ruby / cloze syntax would legitimately shorten the visible text).
        textOf(['a', 'Z', '학', '學', 'は', ' ', '\n'], 0),
        textOf(['b', '교', '校', 'が'], 1),
        (a, b) => {
          const shorter = PROMPT_ORDER.indexOf(cardTextFitTier(a));
          const longer = PROMPT_ORDER.indexOf(cardTextFitTier(`${a}${b}`));
          expect(shorter).toBeGreaterThanOrEqual(0);
          expect(longer).toBeGreaterThanOrEqual(shorter);
        },
      ),
    );
  });

  it('parses the stored card text size, defaulting to M', () => {
    expect(parseCardTextSize('s')).toBe('s');
    expect(parseCardTextSize('l')).toBe('l');
    expect(parseCardTextSize('xl')).toBe('xl');
    expect(parseCardTextSize('m')).toBe('m');
    expect(parseCardTextSize(null)).toBe('m');
    expect(parseCardTextSize('huge')).toBe('m');
  });
});
