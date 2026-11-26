import type { CollectionState, EventFactory, KnownEvent } from '@flash/core';
import type * as StarterUpgrade from './starterUpgrade.ts';

/**
 * The launch trigger for the starter-deck upgrade. `AppContext` imports this tiny module once per
 * launch, behind the leech-backfill sync gate (`isLeechBackfillReady`: at once without a sync
 * provider, else after a sync that completed in this launch) and only when the collection has a
 * deck. It loads the upgrade itself (`starterUpgrade.ts`, with the catalog and the upgrade code)
 * only when a deck came from the starter catalog, so the scan stays out of the initial bundle (§8).
 */
export interface StarterUpgradeLaunch {
  getState: () => CollectionState;
  /** Read after the lazy loads, so a collection reset meanwhile is respected. */
  factory: { readonly current: EventFactory };
  emitEvents: { readonly current: (events: KnownEvent[]) => void };
}

/** Whether any deck was seeded from the starter catalog (its source `package_id`). */
export function hasStarterDeck(state: CollectionState): boolean {
  for (const deck of state.decks.values()) {
    if (deck.source?.package_id?.startsWith('flash-starter:')) return true;
  }
  return false;
}

/**
 * Runs the upgrade when the collection has a starter deck. Resolves `true` when it loaded the
 * upgrade, `false` when there was nothing to look at; rejects when a chunk can't load (the caller
 * logs it, and launch goes on).
 */
export async function runStarterDeckUpgradeAtLaunch(
  launch: StarterUpgradeLaunch,
  load: () => Promise<typeof StarterUpgrade> = () => import('./starterUpgrade.ts'),
): Promise<boolean> {
  if (!hasStarterDeck(launch.getState())) return false;
  const { runStarterDeckUpgrade } = await load();
  await runStarterDeckUpgrade(launch.getState, launch.factory, launch.emitEvents);
  return true;
}
