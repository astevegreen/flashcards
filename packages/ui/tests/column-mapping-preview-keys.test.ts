import { describe, expect, it } from 'vitest';
import { keyedPreviewRows } from '../src/import/ColumnMapping.tsx';

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
