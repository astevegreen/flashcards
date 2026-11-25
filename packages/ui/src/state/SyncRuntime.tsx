import { useLayoutEffect } from 'react';
import type { SyncShell } from './syncShell.ts';
import { useSyncController, type UseSyncControllerOptions } from './useSyncController.ts';

export interface SyncRuntimeProps extends UseSyncControllerOptions {
  shell: SyncShell;
}

/**
 * Runs the sync controller. AppProvider mounts it lazily, so the controller stays out of the
 * initial chunk (P1); until it attaches, `shell` stands in for it.
 */
export function SyncRuntime({ shell, ...options }: SyncRuntimeProps) {
  const controller = useSyncController(options);
  useLayoutEffect(() => shell.attach(controller));
  return null;
}
