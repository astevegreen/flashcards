import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { escapeCsvCell } from '../src/export/anki/select.ts';
import { escapeDelimitedCell } from '../src/import/csv-cell.ts';

// The four escapers `escapeDelimitedCell` replaced (review R8), as they were. Each caller's
// output must stay byte-identical.
const before = {
  /** `exportCsv` (`import/csv-export.ts`). */
  csvExport(value: string, delimiter: string): string {
    if (
      value.includes('"') ||
      value.includes(delimiter) ||
      /[\r\n]/.test(value) ||
      value !== value.trim()
    ) {
      return `"${value.replaceAll('"', '""')}"`;
    }
    return value;
  },
  /** Anki CSV export (`export/anki/select.ts`). */
  anki(value: string, delimiter: string): string {
    if (
      value.startsWith('#') ||
      value.includes('"') ||
      value.includes(delimiter) ||
      /[\r\n]/.test(value)
    ) {
      return `"${value.replaceAll('"', '""')}"`;
    }
    return value;
  },
  /** Card ID write-back (`sources/tabular.ts`). */
  writeBack(value: string, delimiter: string): string {
    if (
      value.includes(delimiter) ||
      value.includes('"') ||
      value.includes('\n') ||
      value.includes('\r')
    ) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  },
  /** `.xlsx` grid to CSV (`ui/src/sources/cloudFileImport.ts`), after its trim. */
  xlsxGrid(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  },
};

// Strings rich in the characters the rules look at.
const cell = fc.string({
  unit: fc.constantFrom('a', 'é', '漢', ' ', '\t', ',', ';', '"', '#', '\r', '\n', '　'),
  maxLength: 12,
});
const delimiter = fc.constantFrom(',', '\t');

describe('escapeDelimitedCell', () => {
  it('quotes a cell with a quote, the delimiter or a line break, doubling inner quotes', () => {
    expect(escapeDelimitedCell('plain', ',')).toBe('plain');
    expect(escapeDelimitedCell('a,b', ',')).toBe('"a,b"');
    expect(escapeDelimitedCell('a,b', '\t')).toBe('a,b');
    expect(escapeDelimitedCell('a\tb', '\t')).toBe('"a\tb"');
    expect(escapeDelimitedCell('say "hi"', ',')).toBe('"say ""hi"""');
    expect(escapeDelimitedCell('a\nb', ',')).toBe('"a\nb"');
    expect(escapeDelimitedCell('a\rb', ',')).toBe('"a\rb"');
    expect(escapeDelimitedCell(' a ', ',')).toBe(' a ');
    expect(escapeDelimitedCell(' a ', ',', { quoteOuterSpace: true })).toBe('" a "');
    expect(escapeDelimitedCell('#a', ',')).toBe('#a');
    expect(escapeDelimitedCell('#a', ',', { quoteLeadingHash: true })).toBe('"#a"');
    expect(escapeDelimitedCell('a#', ',', { quoteLeadingHash: true })).toBe('a#');
  });

  it('gives every former caller byte-identical output', () => {
    fc.assert(
      fc.property(cell, delimiter, (value, d) => {
        expect(escapeDelimitedCell(value, d, { quoteOuterSpace: true })).toBe(
          before.csvExport(value, d),
        );
        expect(escapeCsvCell(value, d)).toBe(before.anki(value, d));
        expect(escapeDelimitedCell(value, d)).toBe(before.writeBack(value, d));
        expect(escapeDelimitedCell(value, ',')).toBe(before.xlsxGrid(value));
      }),
      { numRuns: 2000 },
    );
  });
});
