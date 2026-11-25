import { describe, expect, it } from 'vitest';
import { STARTER_DECKS } from '../../core/src/starters/index.ts';
import { starterSourceCredits } from '../src/packs/starterSourceCredits.ts';

describe('starter-deck credits in About & Open Data Licenses', () => {
  it('lists every starter source once, with its licence attribution and the decks using it', () => {
    const credits = starterSourceCredits();
    const names = credits.map((c) => c.source.name);
    expect(new Set(names).size).toBe(names.length);
    for (const deck of STARTER_DECKS) {
      for (const source of deck.sources) {
        const credit = credits.find((c) => c.source.name === source.name);
        expect(credit?.decks).toContain(deck.name);
        expect(credit?.source.attribution).not.toBe('');
      }
    }
    // KOGL Type 1 asks for the source to be named, in the form KOGL gives.
    const nikl = credits.find((c) => c.source.licence.startsWith('KOGL Type 1'));
    expect(nikl?.source.attribution).toContain('국립국어원');
    expect(nikl?.source.attribution).toContain('공공누리 제1유형');
  });

  it('merges a source shared by two decks', () => {
    const base = STARTER_DECKS[0];
    if (!base) throw new Error('no starter decks');
    const credits = starterSourceCredits([base, { ...base, slug: 'other', name: 'Other deck' }]);
    expect(credits).toHaveLength(base.sources.length);
    expect(credits[0]?.decks).toEqual([base.name, 'Other deck']);
  });
});
