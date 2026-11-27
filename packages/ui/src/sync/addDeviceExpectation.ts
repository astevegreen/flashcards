import type { Storage } from '@flash/platform';
import { useSyncExternalStore } from 'react';
import { isShareableCollectionId, type AddDeviceLink } from './addDeviceLink.ts';
import { isAddDeviceProvider } from './addDeviceLinkShare.ts';

/**
 * The add-device link this device was opened with, kept in the device's own key-value store (never
 * synced) until the first sync shows whether it reached that collection. It survives the sign-in
 * redirect, which reloads the page. Holds only the provider and the collection id.
 */
export const ADD_DEVICE_KV_KEY = 'add_device_link_v1';

type KvStore = Pick<Storage, 'getKv' | 'setKv' | 'deleteKv'>;

export function parseAddDeviceExpectation(raw: unknown): AddDeviceLink | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const provider = r['provider'];
  const collectionId = r['collectionId'];
  if (!isAddDeviceProvider(provider) || !isShareableCollectionId(collectionId)) return undefined;
  return { provider, collectionId };
}

const settled = new WeakMap<KvStore, AddDeviceLink | undefined>();
const reads = new WeakMap<KvStore, Promise<AddDeviceLink | undefined>>();
const listeners = new Set<() => void>();

function settle(storage: KvStore, value: AddDeviceLink | undefined): void {
  settled.set(storage, value);
  // A copy: a listener that subscribes again while being told must not be told twice.
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One read per storage object; started at app start so Settings can decide synchronously. */
export function addDeviceExpectationResource(storage: KvStore): Promise<AddDeviceLink | undefined> {
  let read = reads.get(storage);
  if (!read) {
    const pending = storage
      .getKv(ADD_DEVICE_KV_KEY)
      .then(parseAddDeviceExpectation)
      .catch(() => undefined);
    read = pending;
    reads.set(storage, pending);
    void pending.then((value) => {
      if (reads.get(storage) === pending) settle(storage, value);
    });
  }
  return read;
}

/** The expectation as last read or saved (`undefined` until the first read settles). */
export function peekAddDeviceExpectation(storage: KvStore): AddDeviceLink | undefined {
  return settled.get(storage);
}

/**
 * {@link peekAddDeviceExpectation} for a component: it re-renders when the expectation is read,
 * saved or cleared. Sync status changes no longer re-render every `useApp()` consumer (P3), so a
 * cleared link has to say so itself.
 */
export function useAddDeviceExpectation(storage: KvStore): AddDeviceLink | undefined {
  const read = () => settled.get(storage);
  return useSyncExternalStore(subscribe, read, read);
}

function remember(storage: KvStore, value: AddDeviceLink | undefined): void {
  reads.set(storage, Promise.resolve(value));
  settle(storage, value);
}

/** Saves the link a new device was opened with (only links that name a collection). */
export async function saveAddDeviceExpectation(
  storage: KvStore,
  link: AddDeviceLink,
): Promise<void> {
  const value = parseAddDeviceExpectation(link);
  if (!value) return;
  remember(storage, value);
  try {
    await storage.setKv(ADD_DEVICE_KV_KEY, value);
  } catch {
    // Best effort: without it the app simply cannot confirm the collection after sign-in.
  }
}

export async function clearAddDeviceExpectation(storage: KvStore): Promise<void> {
  remember(storage, undefined);
  try {
    await storage.deleteKv(ADD_DEVICE_KV_KEY);
  } catch {
    // Best effort.
  }
}
