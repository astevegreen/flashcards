import type { KnownEvent } from '@flash/core';
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { useStarterDeckUpgradeAtLaunch } from '../onboarding/starterUpgradeLaunch.ts';
import type { SyncShell } from './syncShell.ts';
import type { SyncStateStore } from './syncStateStore.ts';
import { useSyncController, type UseSyncControllerOptions } from './useSyncController.ts';

export interface SyncRuntimeProps extends Omit<
  UseSyncControllerOptions,
  'syncState' | 'setSyncState'
> {
  shell: SyncShell;
  /** AppProvider's sync status store: this runtime reads and writes it (P3). */
  syncStore: SyncStateStore;
  /** AppContext's `emitEvents`, for the launch-time starter-deck upgrade. */
  emitEventsRef: { readonly current: (events: readonly KnownEvent[]) => void };
}

/**
 * Runs the sync controller. AppProvider mounts it lazily, so the controller stays out of the
 * initial chunk (P1); until it attaches, `shell` stands in for it. It also hosts the launch-time
 * starter-deck upgrade, which waits on this launch's sync (onboarding/starterUpgradeLaunch.ts).
 */
export function SyncRuntime({ shell, syncStore, emitEventsRef, ...options }: SyncRuntimeProps) {
  const syncState = useSyncExternalStore(syncStore.subscribe, syncStore.get, syncStore.get);
  const controller = useSyncController({ ...options, syncState, setSyncState: syncStore.set });
  useLayoutEffect(() => shell.attach(controller));
  useStarterDeckUpgradeAtLaunch(syncState, options.stateRef, options.factoryRef, emitEventsRef);
  return null;
}
