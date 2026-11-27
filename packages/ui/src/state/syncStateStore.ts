import {
  createContext,
  useContext,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { SyncUiState } from './useSyncController.ts';

/**
 * The sync status, outside the `useApp()` value (P3): a sync tick re-renders only the components
 * that read it through {@link useSyncState}, not every `useApp()` consumer.
 */
export interface SyncStateStore {
  get: () => SyncUiState;
  /** Like a `useState` setter. An update that returns the same object notifies nobody. */
  set: Dispatch<SetStateAction<SyncUiState>>;
  subscribe: (listener: () => void) => () => void;
}

export function createSyncStateStore(initial: SyncUiState): SyncStateStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(update) {
      const next = typeof update === 'function' ? update(current) : update;
      if (Object.is(next, current)) return;
      current = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const SyncStateContext = createContext<SyncStateStore | null>(null);

export function useSyncStateStore(): SyncStateStore {
  const store = useContext(SyncStateContext);
  if (!store) throw new Error('useSyncState must be used inside AppProvider');
  return store;
}

const whole = (state: SyncUiState): SyncUiState => state;

/**
 * The sync status, or the part `select` picks. The component re-renders when that value changes
 * (`Object.is`), so pick a primitive (`(s) => s.provider`) where that is all it needs.
 */
export function useSyncState(): SyncUiState;
export function useSyncState<T>(select: (state: SyncUiState) => T): T;
export function useSyncState<T>(select?: (state: SyncUiState) => T): T | SyncUiState {
  const store = useSyncStateStore();
  const pick = select ?? whole;
  const read = () => pick(store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}
