import { SAMPLE_DECKS, type SampleDeckInfo } from '@flash/core/samples';
import type { AppContextValue } from '../state/AppContext.tsx';

/**
 * The single seam between first-run onboarding and the decks it offers. Onboarding lists
 * `ONBOARDING_DECKS` (pick a language, then a deck) and seeds the picked deck through
 * `startOnboardingDeck`. Only this module knows where the decks come from, so swapping the
 * built-in sample decks for curated starter decks touches nothing else. It is loaded only with
 * the lazily loaded empty-collection screen (§8).
 */
export type OnboardingDeckInfo = SampleDeckInfo;

/** Decks first-run onboarding offers, in display order. */
export const ONBOARDING_DECKS: readonly OnboardingDeckInfo[] = SAMPLE_DECKS;

export type OnboardingDeckApp = Pick<
  AppContextValue,
  'getEventFactory' | 'setActiveDeckId' | 'emitEvents'
>;

/** Seeds the picked onboarding deck and makes it the active deck. Rejects if it can't load. */
export async function startOnboardingDeck(slug: string, app: OnboardingDeckApp): Promise<void> {
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
