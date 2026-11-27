import { describe, expect, it } from 'vitest';
import { keyedPreviewRows, previewFieldLines } from '../src/import/ColumnMapping.tsx';

describe('keyedPreviewRows', () => {
  it('keys rows by content and keeps repeated rows apart', () => {
    const a = { fields: { word: '나무' }, tags: ['nature'], cardId: '' };
    const b = { fields: { word: '하늘' }, tags: [], cardId: '' };
    const keyed = keyedPreviewRows([a, b, { ...a }]);
    expect(keyed.map((k) => k.row)).toEqual([a, b, a]);
    const keys = keyed.map((k) => k.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys[2]).toBe(`${keys[0]}#1`);
    expect(keyedPreviewRows([b, a]).map((k) => k.key)).toEqual([keys[1], keys[0]]);
  });
});

describe('previewFieldLines', () => {
  const noteType = {
    id: 'nt',
    name: 'Proto',
    fields: [
      { key: 'constructor', label: 'Key', kind: 'text' as const, lang: 'en' },
      { key: 'toString', label: 'Other', kind: 'text' as const, lang: 'en' },
      { key: 'word', label: 'Word', kind: 'text' as const, lang: 'ko' },
    ],
  };

  it('shows only fields the row holds, reading own properties (S4)', () => {
    const row = { fields: { word: '나무  숲' }, tags: [], cardId: '' };
    expect(previewFieldLines(noteType, row)).toEqual([
      { key: 'word', label: 'Word', value: '나무 숲' },
    ]);
    const held = { fields: { constructor: 'k', word: '' }, tags: [], cardId: '' };
    expect(previewFieldLines(noteType, held)).toEqual([
      { key: 'constructor', label: 'Key', value: 'k' },
    ]);
  });
});
