import { STARTER_DECKS, type StarterDeckInfo, type StarterDeckSource } from '@flash/core/starters';

export interface StarterSourceCredit {
  source: StarterDeckSource;
  /** Names of the starter decks built from this source, in catalog order. */
  decks: string[];
}

/**
 * The open-data sources of the curated starter decks, each once, with the decks that use it.
 * Starter cards carry no per-card credit, so this list (shown in About & Open Data Licenses), each
 * deck's description and THIRD-PARTY-NOTICES.txt are where the attribution the licences ask for
 * lives. Only the tiny catalog is read: no deck content is loaded.
 */
export function starterSourceCredits(
  decks: readonly StarterDeckInfo[] = STARTER_DECKS,
): StarterSourceCredit[] {
  const byName = new Map<string, StarterSourceCredit>();
  for (const deck of decks) {
    for (const source of deck.sources) {
      const entry = byName.get(source.name) ?? { source, decks: [] };
      entry.decks.push(deck.name);
      byName.set(source.name, entry);
    }
  }
  return [...byName.values()];
}
