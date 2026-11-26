import type { CollectionState, EventFactory, KnownEvent } from '@flash/core';
import { loadStarterDeck } from '@flash/core/starters';
import {
  buildStarterDeckUpgradeEvents,
  loadStarterLegacyGlosses,
  planStarterDeckUpgrade,
  starterDecksDueForUpgrade,
} from '@flash/core/starter-upgrade';

/**
 * The starter-deck upgrade at launch (see `packages/core/src/starters/upgrade.ts`): a starter
 * deck seeded from an older release gets the current release's text wherever the user left the
 * old generated text, once per release. Lazy-loaded only when the collection holds a starter
 * deck (§8); the deck content and the 1.0.0 gloss table load only when a deck is due. The factory
 * and `emitEvents` are read through refs after the awaits, so a reset meanwhile is respected.
 */
export async function runStarterDeckUpgrade(
  getState: () => CollectionState,
  factory: { readonly current: EventFactory },
  emitEvents: { readonly current: (events: KnownEvent[]) => void },
): Promise<void> {
  const due = starterDecksDueForUpgrade(getState());
  if (due.length === 0) return;
  const legacy = await loadStarterLegacyGlosses();
  for (const info of due) {
    const content = await loadStarterDeck(info.slug);
    // Planned against the state after the awaits, so nothing applied meanwhile is overwritten.
    const plan = planStarterDeckUpgrade(getState(), info, content, legacy);
    if (plan === undefined) continue;
    emitEvents.current(buildStarterDeckUpgradeEvents(factory.current, plan, Date.now()));
  }
}
