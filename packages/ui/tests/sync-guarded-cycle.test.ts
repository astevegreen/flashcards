import { describe, expect, it } from 'vitest';
import type { SetStateAction } from 'react';
import { runGuardedSyncCycle, type SyncUiState } from '../src/state/useSyncController.ts';

function syncingState(): SyncUiState {
  return {
    provider: 'google_drive',
    status: 'syncing',
    isOnline: true,
    readOnly: false,
    pendingCount: 0,
    lastPulledCount: 0,
    lastPushedCount: 0,
  };
}

function holder() {
  let state = syncingState();
  const set = (next: SetStateAction<SyncUiState>) => {
    state = typeof next === 'function' ? next(state) : next;
  };
  return { get: () => state, set };
}

describe('a sync cycle that fails to run (C7)', () => {
  it('ends as a retryable error when the sync code fails to load', async () => {
    const h = holder();
    await runGuardedSyncCycle(async () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    }, h.set);
    expect(h.get().status).toBe('error');
    expect(h.get().errorMessage).toMatch(/couldn't run/);
  });

  it('leaves the status the cycle itself set', async () => {
    const h = holder();
    await runGuardedSyncCycle(async () => {
      h.set((prev) => ({ ...prev, status: 'synced' }));
    }, h.set);
    expect(h.get().status).toBe('synced');
    expect(h.get().errorMessage).toBeUndefined();
  });
});
