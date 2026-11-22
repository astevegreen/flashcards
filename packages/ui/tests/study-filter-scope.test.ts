import { describe, expect, it } from 'vitest';
import { isStudyFilterInScope, type ActiveStudyFilter } from '../src/study/filterStore.ts';

const KO = 'deck-ko';
const JA = 'deck-ja';
const decks = new Map<string, { archived?: boolean }>([
  [KO, { archived: false }],
  [JA, { archived: false }],
]);

function trouble(deckId: string | undefined, deckIds?: string[]): ActiveStudyFilter {
  return {
    label: 'Trouble cards',
    filter: {
      ...(deckIds ? { deckIds } : {}),
      performance: { minAgainCount: 1, hardest: 50 },
    },
    scope: { deckId },
  };
}

describe('Phase 9 study filter scope', () => {
  it('stays active while the Study deck selection is unchanged', () => {
    expect(isStudyFilterInScope(trouble(KO, [KO]), KO, decks)).toBe(true);
    expect(isStudyFilterInScope(trouble(undefined), undefined, decks)).toBe(true);
  });

  it('drops a Korean-scoped filter once another deck is studied (Library "Study")', () => {
    expect(isStudyFilterInScope(trouble(KO, [KO]), JA, decks)).toBe(false);
    expect(isStudyFilterInScope(trouble(KO, [KO]), undefined, decks)).toBe(false);
    expect(isStudyFilterInScope(trouble(undefined, [JA]), KO, decks)).toBe(false);
  });

  it('drops a filter whose decks were archived or wiped by a collection reset', () => {
    expect(isStudyFilterInScope(trouble(undefined, [KO]), undefined, new Map())).toBe(false);
    const archived = new Map([[KO, { archived: true }]]);
    expect(isStudyFilterInScope(trouble(undefined, [KO]), undefined, archived)).toBe(false);
  });

  it('treats an unscoped filter as deck-independent', () => {
    const active: ActiveStudyFilter = { label: 'Study this filter', filter: { deckIds: [JA] } };
    expect(isStudyFilterInScope(active, KO, decks)).toBe(true);
  });
});
