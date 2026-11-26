import { describe, expect, it } from 'vitest';
import type { Note } from '@flash/core';
import { createDeckPresenceIndex } from '../src/dictionary/DictionaryPanel.tsx';

function note(
  id: string,
  deck_id: string,
  fields: Record<string, string>,
  extra: Partial<Note> = {},
) {
  return { id, deck_id, fields, archived: false, ...extra } as unknown as Note;
}

describe('dictionary deck presence index (P9)', () => {
  it('indexes a deck only when asked, once per collection change', () => {
    const notes = new Map<string, Note>([
      ['a', note('a', 'd1', { front: '한 일 (一)', back: '{b:one}' }, { source_key: 'dict:7' })],
      ['b', note('b', 'd2', { front: '二' })],
      ['c', note('c', 'd1', { front: 'archived' }, { archived: true })],
    ]);
    let reads = 0;
    const counted = new Proxy(notes, {
      get(target, prop, receiver) {
        if (prop === 'values') reads += 1;
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const index = createDeckPresenceIndex(counted);
    expect(reads).toBe(0);
    const d1 = index.get('d1');
    expect(d1?.sourceKeys.has('dict:7')).toBe(true);
    expect(d1?.exact.has('한 일 (一)')).toBe(true);
    expect(d1?.exact.has('一')).toBe(true);
    expect(d1?.exact.has('one')).toBe(true);
    expect(d1?.exact.has('二')).toBe(false);
    expect(d1?.exact.has('archived')).toBe(false);
    expect(index.get('d1')).toBe(d1);
    expect(reads).toBe(1);
    expect(index.get('d2')?.exact.has('二')).toBe(true);
    expect(reads).toBe(2);
  });
});
