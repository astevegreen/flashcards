import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { escapeDelimitedCell } from '../src/import/csv-cell.ts';
import { parseDelimitedText } from '../src/import/csv.ts';

const tsv = (rows: string[][]) => rows.map((r) => r.join('\t')).join('\n') + '\n';

describe('CSV/TSV quotes that do not close (C1)', () => {
  it('keeps every row after a straight quote closed by a curly one', () => {
    const text = tsv([
      ['word', 'meaning'],
      ['일벌레', '"work worm”, a workaholic'],
      ['물', 'water'],
      ['불', 'fire'],
    ]);
    const parsed = parseDelimitedText(text, { delimiter: '\t' });
    expect(parsed.rows).toEqual([
      ['일벌레', '"work worm”, a workaholic'],
      ['물', 'water'],
      ['불', 'fire'],
    ]);
  });

  it('keeps the quotes of a field where text follows the closing quote', () => {
    const text = tsv([
      ['word', 'meaning'],
      ['히로뽕', '"philopon", methamphetamine'],
      ['물', 'water'],
    ]);
    expect(parseDelimitedText(text, { delimiter: '\t' }).rows).toEqual([
      ['히로뽕', '"philopon", methamphetamine'],
      ['물', 'water'],
    ]);
  });

  it('still reads real quoted fields: delimiters, newlines, doubled quotes, trailing spaces', () => {
    const text = 'a,b\n"x, y","line 1\nline 2"\n"say ""hi""" ,z\n';
    expect(parseDelimitedText(text).rows).toEqual([
      ['x, y', 'line 1\nline 2'],
      ['say "hi"', 'z'],
    ]);
  });

  it('a lone quote at the very end is plain text', () => {
    expect(parseDelimitedText('a,b\n1,"\n').rows).toEqual([['1', '"']]);
  });

  it('round-trips any cells the exporter quotes', () => {
    const cell = fc.string({ unit: fc.constantFrom('a', '"', '”', ',', '\t', '\n', ' ', '가') });
    fc.assert(
      fc.property(
        fc.array(fc.array(cell, { minLength: 2, maxLength: 2 }), { minLength: 1, maxLength: 5 }),
        (rows) => {
          const body = rows.filter((r) => r.some((c) => c.trim() !== ''));
          const text = [
            'h1,h2',
            ...body.map((r) => r.map((c) => escapeDelimitedCell(c, ',')).join(',')),
          ].join('\n');
          expect(parseDelimitedText(text, { delimiter: ',' }).rows).toEqual(body);
        },
      ),
    );
  });
});
