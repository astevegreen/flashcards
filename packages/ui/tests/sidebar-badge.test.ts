import { describe, expect, it } from 'vitest';
import {
  getSidebarBadge,
  sidebarBadgeOpensSettings,
  sidebarBadgeTitle,
} from '../src/layout/sidebarBadge.ts';
import type { SyncUiState } from '../src/state/useSyncController.ts';

const base: SyncUiState = {
  provider: 'onedrive',
  status: 'idle',
  isOnline: true,
  readOnly: false,
  pendingCount: 0,
  lastPulledCount: 0,
  lastPushedCount: 0,
};

const choicePending: SyncUiState = {
  ...base,
  readOnly: true,
  errorMessage: 'Choose below',
  collectionChoice: {
    expectedCollectionId: 'col-11111111-1111-4111-8111-111111111111',
    remoteCollectionId: 'col-22222222-2222-4222-8222-222222222222',
  },
};

describe('sidebar sync badge', () => {
  it('syncs on tap when connected and nothing needs Settings', () => {
    expect(sidebarBadgeOpensSettings(base)).toBe(false);
    expect(sidebarBadgeOpensSettings({ ...base, status: 'synced' })).toBe(false);
    expect(sidebarBadgeTitle(base)).toBe('Sync now');
  });

  it('opens Settings, where the choice is shown, while a collection choice is pending', () => {
    expect(sidebarBadgeOpensSettings(choicePending)).toBe(true);
    // Whatever the status says (an automatic sync may be running), the choice wins.
    expect(sidebarBadgeOpensSettings({ ...choicePending, status: 'syncing' })).toBe(true);
    expect(getSidebarBadge(choicePending).label).toBe('Choose');
    expect(getSidebarBadge({ ...choicePending, isOnline: false }).label).toBe('Choose');
    expect(sidebarBadgeTitle(choicePending)).toBe('Choose a collection in Settings');
  });

  it('opens Settings with no provider or a state only Settings can fix', () => {
    expect(sidebarBadgeOpensSettings({ ...base, provider: 'none', status: 'disconnected' })).toBe(
      true,
    );
    for (const status of ['reconnect_required', 'upgrade_required', 'error'] as const) {
      expect(sidebarBadgeOpensSettings({ ...base, status })).toBe(true);
    }
    expect(sidebarBadgeTitle({ ...base, provider: 'none' })).toBe('Configure sync in Settings');
  });
});
