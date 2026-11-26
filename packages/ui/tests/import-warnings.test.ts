import { describe, expect, it } from 'vitest';
import { describeImportWarnings } from '../src/import/importWarnings.ts';

describe('describeImportWarnings', () => {
  it('is empty without warnings, and lists up to three', () => {
    expect(describeImportWarnings([])).toBe('');
    expect(describeImportWarnings([{ message: 'A.' }])).toBe(' 1 warning: A.');
    expect(
      describeImportWarnings(['A.', 'B.', 'C.', 'D.', 'E.'].map((message) => ({ message }))),
    ).toBe(' 5 warnings: A. B. C. (+2 more)');
  });
});
