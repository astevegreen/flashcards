import type { PlatformServices } from '@flash/platform';
import { WebFiles } from './files/web-files.ts';
import { DexieStorage } from './storage/dexie-storage.ts';
import { DevChannelSyncTransport, InMemorySyncTransport } from './sync/in-memory-transport.ts';

export { DexieStorage } from './storage/dexie-storage.ts';
export { WebFiles } from './files/web-files.ts';
export { DevChannelSyncTransport, InMemorySyncTransport } from './sync/in-memory-transport.ts';

export interface ResolvedDevice {
  slug?: string;
  deviceId: string;
  label: string;
}

/**
 * Reads `?device=<slug>` from URL search params for isolated multi-device dev/test runs.
 */
export function resolveDeviceFromUrl(search: string = window.location.search): ResolvedDevice {
  const params = new URLSearchParams(search);
  const raw = params.get('device')?.trim().toLowerCase();
  if (raw && /^[a-z0-9_-]{1,32}$/.test(raw)) {
    return {
      slug: raw,
      deviceId: `device-${raw}`,
      label: `Device ${raw.toUpperCase()}`,
    };
  }
  return {
    deviceId: 'device-local',
    label: 'This Device',
  };
}

export function createWebPlatform(options?: { isDevMode?: boolean }): PlatformServices {
  const resolved = resolveDeviceFromUrl();
  const isDevMode = options?.isDevMode ?? Boolean(resolved.slug);
  const storage = new DexieStorage(resolved.slug);
  const files = new WebFiles();
  const syncTransport = resolved.slug ? new DevChannelSyncTransport() : new InMemorySyncTransport();

  return {
    deviceId: resolved.deviceId,
    deviceLabel: resolved.label,
    isDevMode,
    storage,
    files,
    syncTransport,
  };
}
