import { describe, expect, it } from 'vitest';
import { applyCardIdsToGridAndSerialize } from '../src/sources/tabular.ts';

// C16: `Math.max(...rows)` overflows the call stack somewhere past ~150k arguments.
describe('large grids (C16)', () => {
  it('serializes a 300k-row Card ID write-back without overflowing the stack', () => {
    const grid: string[][] = [['Word', 'Meaning', 'Card ID']];
    for (let i = 0; i < 300_000; i++) grid.push([`w${i}`, `m${i}`, `c${i}`]);
    const out = applyCardIdsToGridAndSerialize(
      grid,
      ',',
      { safeCells: [], skippedCells: [] },
      { cells: [] },
    );
    expect(out.startsWith('Word,Meaning,Card ID')).toBe(true);
    expect(out).toContain('w299999,m299999,c299999');
  });
});
