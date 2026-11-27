import { describe, expect, it, vi } from 'vitest';
import { createSyncStateStore } from '../src/state/syncStateStore.ts';
import type { SyncUiState } from '../src/state/useSyncController.ts';

const initial: SyncUiState = {
  provider: 'none',
  status: 'disconnected',
  isOnline: true,
  readOnly: false,
  pendingCount: 0,
  lastPulledCount: 0,
  lastPushedCount: 0,
};

describe('createSyncStateStore (P3)', () => {
  it('applies values and updaters and notifies each subscriber once per change', () => {
    const store = createSyncStateStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ ...initial, isOnline: false });
    expect(store.get().isOnline).toBe(false);
    store.set((prev) => ({ ...prev, pendingCount: prev.pendingCount + 2 }));
    expect(store.get()).toMatchObject({ isOnline: false, pendingCount: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies nobody when an update returns the current object', () => {
    const store = createSyncStateStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set((prev) => prev);
    store.set(store.get());
    expect(listener).not.toHaveBeenCalled();
    expect(store.get()).toBe(initial);
  });

  it('stops notifying after unsubscribe, also when a listener unsubscribes during a notify', () => {
    const store = createSyncStateStore(initial);
    const later = vi.fn();
    let unsubscribeLater = () => {};
    const first = vi.fn(() => unsubscribeLater());
    const unsubscribeFirst = store.subscribe(first);
    unsubscribeLater = store.subscribe(later);

    store.set({ ...initial, status: 'idle' });
    // The notify loop runs over a copy, so `later` still hears this change.
    expect(first).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    store.set({ ...initial, status: 'syncing' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
  });
});
