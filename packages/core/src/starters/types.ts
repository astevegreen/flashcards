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
  /** Learner content only: no field a card reveals carries a source credit (they are deck-level). */
  fields: Record<string, string>;
  tags: string[];
  /**
   * Provenance of the meaning: the upstream record it came from (`Wikidata L196`,
   * `Unihan 17.0.0 kDefinition`). Metadata only: never shown on a card and not copied into events.
   */
  meaningSource: string;
  /** Set when the meaning is the app's own wording (content/starters/gloss-overrides.json). */
  meaningEdited?: true;
}

/** The lazily loaded content of one starter deck. */
export interface StarterDeckContent {
  slug: string;
  notes: StarterNote[];
}

/**
 * The gloss each reworded starter note showed in 1.0.0, before the 1.1.0 gloss overrides:
 * `{ [deckSlug]: { [noteKey]: gloss } }` (generated, see `glossesBeforeOverrides` in
 * scripts/starters/lib.mjs). Read only by the starter-deck upgrade.
 */
export type StarterLegacyGlosses = Readonly<Record<string, Readonly<Record<string, string>>>>;
