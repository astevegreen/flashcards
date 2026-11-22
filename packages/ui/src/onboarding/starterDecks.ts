import { SAMPLE_DECKS, type SampleDeckInfo } from '@flash/core/samples';
import {
  buildStarterDeckEvents,
  findStarterDeck,
  loadStarterDeck,
  STARTER_DECKS,
  starterDeckId,
  type StarterDeckInfo,
} from '@flash/core/starters';
import type { AppContextValue } from '../state/AppContext.tsx';

/**
 * The single seam between first-run onboarding and the decks it offers. Onboarding lists
 * `ONBOARDING_DECKS` (pick a language, then a deck) and seeds the picked deck through
 * `startOnboardingDeck`. Only this module knows where the decks come from. It is loaded only with
 * the lazily loaded empty-collection screen (§8), and it holds only deck metadata: a starter
 * deck's notes are fetched as their own chunk when that deck is picked.
 *
 * A language with a curated starter deck (built from open data by
 * `scripts/build-starter-decks.mjs`) offers it instead of the built-in sample decks. Languages
 * without one (no open source passed the licence gate yet) keep their sample decks.
 */
export interface OnboardingDeckInfo extends SampleDeckInfo {
  /** `starter`: curated open-data deck; `sample`: built-in sample deck. */
  kind: 'starter' | 'sample';
  /** What the deck contains (starter decks). */
  description?: string;
  /** Credits the deck's licences ask for, one line per source (starter decks). */
  attribution?: readonly string[];
}

function starterEntry(deck: StarterDeckInfo): OnboardingDeckInfo {
  return {
    slug: deck.slug,
    name: deck.name,
    language: deck.language,
    noteCount: deck.noteCount,
    kind: 'starter',
    description: deck.description,
    attribution: deck.sources.map((s) => `${s.name}, ${s.licence}`),
  };
}

/**
 * Sample-deck order, with each language's sample decks swapped for its starter decks (in the
 * first sample's place), so the language order onboarding shows is unchanged.
 */
export function onboardingDecks(
  samples: readonly SampleDeckInfo[],
  starters: readonly StarterDeckInfo[],
): OnboardingDeckInfo[] {
  const startersByLanguage = new Map<string, OnboardingDeckInfo[]>();
  for (const deck of starters) {
    const list = startersByLanguage.get(deck.language) ?? [];
    list.push(starterEntry(deck));
    startersByLanguage.set(deck.language, list);
  }
  const out: OnboardingDeckInfo[] = [];
  const placed = new Set<string>();
  for (const sample of samples) {
    const replacement = startersByLanguage.get(sample.language);
    if (replacement === undefined) {
      out.push({ ...sample, kind: 'sample' });
    } else if (!placed.has(sample.language)) {
      placed.add(sample.language);
      out.push(...replacement);
    }
  }
  for (const [language, list] of startersByLanguage) {
    if (!placed.has(language)) out.push(...list);
  }
  return out;
}

/** Decks first-run onboarding offers, in display order. */
export const ONBOARDING_DECKS: readonly OnboardingDeckInfo[] = onboardingDecks(
  SAMPLE_DECKS,
  STARTER_DECKS,
);

export type OnboardingDeckApp = Pick<
  AppContextValue,
  'getEventFactory' | 'setActiveDeckId' | 'emitEvents'
>;

/** Seeds the picked onboarding deck and makes it the active deck. Rejects if it can't load. */
export async function startOnboardingDeck(slug: string, app: OnboardingDeckApp): Promise<void> {
  const starter = findStarterDeck(slug);
  if (starter !== undefined) {
    // The deck's notes are their own chunk, fetched only now.
    const content = await loadStarterDeck(slug);
    const events = buildStarterDeckEvents(app.getEventFactory(), starter, content);
    app.setActiveDeckId(starterDeckId(slug));
    app.emitEvents(events);
    return;
  }
  const samples = await import('@flash/core/samples');
  const events = samples.buildSampleDeckEvents(
    app.getEventFactory(),
    samples.SAMPLE_SEED_EPOCH_MS,
    {
      deckSlugs: [slug],
    },
  );
  app.setActiveDeckId(samples.sampleDeckId(slug));
  app.emitEvents(events);
}
