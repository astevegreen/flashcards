/** One open-data source a starter deck was built from, with what its licence requires us to show. */
export interface StarterDeckSource {
  name: string;
  /** Licence name, e.g. `KOGL Type 1`, `CC0 1.0`, `Unicode License v3`. */
  licence: string;
  licenceUrl: string;
  sourceUrl: string;
  /** Attribution text the licence asks for (shown wherever the deck's credits are shown). */
  attribution: string;
  /** How the upstream data was changed for the deck. */
  changes: string;
}

/**
 * A curated starter deck as onboarding lists it: tiny metadata only. The notes live in a separate,
 * lazily loaded module (`loadStarterDeck`), so the list never pulls deck content into a bundle.
 */
export interface StarterDeckInfo {
  slug: string;
  name: string;
  /** BCP 47 deck language (`ko`, `zh-Hans`, …). */
  language: string;
  noteTypeId: string;
  noteCount: number;
  /** Starter-deck release (`STARTER_DECKS_VERSION` in scripts/starters/sources.mjs). */
  version: string;
  /** sha256 of the canonical JSON of the deck's notes. */
  contentHash: string;
  description: string;
  sources: readonly StarterDeckSource[];
  /** Generated module name under `starters/generated/` (for the lazy loader). */
  module: string;
}

export interface StarterNote {
  /** Stable source key (`nikl:가다01:verb`, `unihan:U+7684`): the note id derives from it. */
  key: string;
  fields: Record<string, string>;
  tags: string[];
}

/** The lazily loaded content of one starter deck. */
export interface StarterDeckContent {
  slug: string;
  notes: StarterNote[];
}
