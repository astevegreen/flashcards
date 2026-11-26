import type { CollectionState, EventFactory, KnownEvent } from '@flash/core';
import { useEffect, useRef, useState } from 'react';
import { isLeechBackfillReady } from '../state/leechBackfillGate.ts';
import type { SyncUiState } from '../state/useSyncController.ts';
import type * as StarterUpgrade from './starterUpgrade.ts';

/**
 * The launch trigger for the starter-deck upgrade. It runs inside `SyncRuntime`, which
 * `AppContext` mounts lazily on every launch, so nothing here is in the initial bundle (§8). Once
 * per launch, behind the leech-backfill sync gate (`isLeechBackfillReady`: at once without a sync
 * provider, else after a sync that completed in this launch, so a device sees another device's
 * upgrade first), and only when the collection has a deck from the starter catalog, it loads the
 * upgrade itself (`starterUpgrade.ts`, with the catalog and the upgrade code).
 */
export interface StarterUpgradeLaunch {
  getState: () => CollectionState;
  /** Read after the lazy loads, so a collection reset meanwhile is respected. */
  factory: { readonly current: EventFactory };
  emitEvents: { readonly current: (events: readonly KnownEvent[]) => void };
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
 * upgrade, `false` when there was nothing to look at; rejects when a chunk can't load.
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

/**
 * The launch-time hook: whether this launch may run the upgrade (`ready`), and running it once
 * when it may. A failure is logged and never blocks launch.
 */
export function useStarterDeckUpgradeAtLaunch(
  syncState: Pick<SyncUiState, 'provider' | 'status' | 'readOnly' | 'lastSyncedAt'>,
  stateRef: { readonly current: CollectionState },
  factory: StarterUpgradeLaunch['factory'],
  emitEvents: StarterUpgradeLaunch['emitEvents'],
): void {
  // SyncRuntime mounts before this launch's first sync can complete (it runs the controller).
  const [launchedAtMs] = useState(() => Date.now());
  const ready = isLeechBackfillReady(syncState, launchedAtMs);
  const doneRef = useRef(false);
  useEffect(() => {
    if (!ready || doneRef.current) return;
    doneRef.current = true;
    runStarterDeckUpgradeAtLaunch({ getState: () => stateRef.current, factory, emitEvents }).catch(
      (err: unknown) => console.warn('Starter-deck upgrade failed', err),
    );
  }, [ready, stateRef, factory, emitEvents]);
}
