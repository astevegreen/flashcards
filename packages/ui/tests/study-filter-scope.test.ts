import { describe, expect, it } from 'vitest';
import {
  isStudyFilterInScope,
  resolveStudyQueueDeckId,
  type ActiveStudyFilter,
} from '../src/study/filterStore.ts';
import { studySetScopeFilter } from '../src/study/StudySetsSection.tsx';

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

  it('runs a Study Set that names its own decks on those decks, whatever the header shows', () => {
    // "Hanja words" saved under Korean, started while the header is on Japanese.
    const hanjaSet = {
      filter: { deckIds: [KO], categories: { mode: 'any' as const, tags: ['hanja'] } },
    };
    expect(resolveStudyQueueDeckId(hanjaSet, JA)).toBeUndefined();
    expect(resolveStudyQueueDeckId(hanjaSet, undefined)).toBeUndefined();
    // A deck-less set is limited to the header deck, and its row counts use the same scope.
    const anyDeck = { filter: { categories: { mode: 'any' as const, tags: ['hanja'] } } };
    expect(resolveStudyQueueDeckId(anyDeck, JA)).toBe(JA);
    expect(resolveStudyQueueDeckId(undefined, JA)).toBe(JA);
    expect(studySetScopeFilter(anyDeck.filter, JA).deckIds).toEqual([JA]);
    expect(studySetScopeFilter(anyDeck.filter, undefined)).toBe(anyDeck.filter);
    expect(studySetScopeFilter(hanjaSet.filter, JA)).toBe(hanjaSet.filter);
  });
});
