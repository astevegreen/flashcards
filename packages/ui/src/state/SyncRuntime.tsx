import type { KnownEvent } from '@flash/core';
import { useLayoutEffect } from 'react';
import { useStarterDeckUpgradeAtLaunch } from '../onboarding/starterUpgradeLaunch.ts';
import type { SyncShell } from './syncShell.ts';
import { useSyncController, type UseSyncControllerOptions } from './useSyncController.ts';

export interface SyncRuntimeProps extends UseSyncControllerOptions {
  shell: SyncShell;
  /** AppContext's `emitEvents`, for the launch-time starter-deck upgrade. */
  emitEventsRef: { readonly current: (events: readonly KnownEvent[]) => void };
}

/**
 * Runs the sync controller. AppProvider mounts it lazily, so the controller stays out of the
 * initial chunk (P1); until it attaches, `shell` stands in for it. It also hosts the launch-time
 * starter-deck upgrade, which waits on this launch's sync (onboarding/starterUpgradeLaunch.ts).
 */
export function SyncRuntime({ shell, emitEventsRef, ...options }: SyncRuntimeProps) {
  const controller = useSyncController(options);
  useLayoutEffect(() => shell.attach(controller));
  useStarterDeckUpgradeAtLaunch(
    options.syncState,
    options.stateRef,
    options.factoryRef,
    emitEventsRef,
  );
  return null;
}
