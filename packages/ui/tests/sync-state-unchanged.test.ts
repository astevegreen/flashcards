import { describe, expect, it } from 'vitest';
import { keepSyncStateIfUnchanged, type SyncUiState } from '../src/state/useSyncController.ts';

const idle: SyncUiState = {
  provider: 'google_drive',
  status: 'idle',
  isOnline: true,
  readOnly: false,
  pendingCount: 0,
  lastPulledCount: 0,
  lastPushedCount: 0,
};

// P3: a sync update that changes nothing must keep the old state object, so React skips the
// AppProvider render and no useApp() consumer re-renders for it.
describe('keepSyncStateIfUnchanged (P3)', () => {
  it('keeps the previous object when an update changes no field', () => {
    expect(keepSyncStateIfUnchanged(idle, { ...idle, isOnline: true })).toBe(idle);
  });

  it('takes the update when a field changes', () => {
    const next = { ...idle, status: 'syncing' as const };
    expect(keepSyncStateIfUnchanged(idle, next)).toBe(next);
  });

  it('takes the update when a field is added or removed', () => {
    const withError = { ...idle, status: 'error' as const, errorMessage: 'x' };
    const { errorMessage: _dropped, ...cleared } = withError;
    expect(keepSyncStateIfUnchanged(idle, { ...idle, lastSyncedAt: 5 })).not.toBe(idle);
    expect(keepSyncStateIfUnchanged(withError, cleared)).toBe(cleared);
  });

  it('compares nested objects by identity, so a new collection choice is an update', () => {
    const choice = { expectedCollectionId: 'a', remoteCollectionId: 'b' };
    const asked = { ...idle, collectionChoice: choice };
    expect(keepSyncStateIfUnchanged(asked, { ...asked })).toBe(asked);
    const again = { ...asked, collectionChoice: { ...choice } };
    expect(keepSyncStateIfUnchanged(asked, again)).toBe(again);
  });
});
