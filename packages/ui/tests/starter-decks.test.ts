import { describe, expect, it } from 'vitest';
import type { SampleDeckInfo } from '../../core/src/samples/decks.ts';
import type { StarterDeckInfo } from '../../core/src/starters/index.ts';
import {
  ONBOARDING_DECKS,
  onboardingDecks,
  type OnboardingDeckInfo,
} from '../src/onboarding/starterDecks.ts';

const sample = (slug: string, language: string): SampleDeckInfo => ({
  slug,
  name: slug,
  language,
  noteCount: 3,
});

const starter = (slug: string, language: string): StarterDeckInfo => ({
  slug,
  name: slug,
  language,
  noteTypeId: 'preset:vocab-ko',
  noteCount: 120,
  version: '1.0.0',
  contentHash: 'x',
  description: 'd',
  sources: [
    {
      name: 'Source',
      licence: 'CC0 1.0',
      licenceUrl: 'https://example.org/l',
      sourceUrl: 'https://example.org/s',
      attribution: 'a',
      changes: 'c',
    },
  ],
  module: slug,
});

describe('onboarding deck seam', () => {
  it('swaps a language’s sample decks for its starter decks, keeping the language order', () => {
    const decks = onboardingDecks(
      [sample('s-ko', 'ko'), sample('s-ja', 'ja'), sample('s-ko2', 'ko'), sample('s-en', 'en')],
      [starter('st-ko', 'ko'), starter('st-de', 'de')],
    );
    expect(decks.map((d) => [d.slug, d.kind])).toEqual([
      ['st-ko', 'starter'],
      ['s-ja', 'sample'],
      ['s-en', 'sample'],
      // A starter language with no sample deck goes last.
      ['st-de', 'starter'],
    ]);
    expect(decks[0]?.attribution).toEqual(['Source, CC0 1.0']);
  });

  it('accepts a plain sample-deck literal as an entry (kind is optional)', () => {
    const plain: OnboardingDeckInfo = sample('s-ko', 'ko');
    expect(plain.kind ?? 'sample').toBe('sample');
  });

  it('offers the curated Korean and Mandarin starters and keeps samples for the other languages', () => {
    const byLanguage = new Map<string, string[]>();
    for (const deck of ONBOARDING_DECKS) {
      byLanguage.set(deck.language, [...(byLanguage.get(deck.language) ?? []), deck.slug]);
    }
    expect([...byLanguage.keys()]).toEqual(['ko', 'ja', 'zh-Hans', 'en']);
    expect(byLanguage.get('ko')).toEqual(['starter-ko-core']);
    expect(byLanguage.get('zh-Hans')).toEqual(['starter-zh-common']);
    // No open Japanese or English source passed the licence gate yet.
    expect(byLanguage.get('ja')).toEqual(['sample-ja-vocab', 'sample-ja-cloze']);
    expect(byLanguage.get('en')).toEqual(['sample-en-vocab']);
    for (const deck of ONBOARDING_DECKS.filter((d) => d.kind === 'starter')) {
      expect(deck.attribution?.length).toBeGreaterThan(0);
    }
  });
});
