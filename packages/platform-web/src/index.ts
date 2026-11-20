import type { Auth, PlatformServices, ReplayWorkerClient, SyncTransport } from '@flash/platform';
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

export interface CreateWebPlatformOptions {
  isDevMode?: boolean;
  googleClientId?: string;
  tokenHelperUrl?: string;
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

export function createWebPlatform(options?: CreateWebPlatformOptions): PlatformServices {
  const resolved = resolveDeviceFromUrl();
  const isDevMode = options?.isDevMode ?? Boolean(resolved.slug);
  const storage = new DexieStorage(resolved.slug);
  const files = new WebFiles();
  const devTransport = resolved.slug ? new DevChannelSyncTransport() : null;
  const syncTransport: SyncTransport = devTransport ?? new InMemorySyncTransport();

  const googleClientId = options?.googleClientId?.trim() ?? '';
  const tokenHelperUrl = options?.tokenHelperUrl?.trim() ?? '';
  const googleOAuthConfigured = Boolean(googleClientId && tokenHelperUrl);
  const supportsLocalFolderSync =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      'function';

  let cachedGoogleAuth: Auth | null = null;
  let cachedDriveTransport: SyncTransport | null = null;

  const getGoogleAuth = async (): Promise<Auth> => {
    if (!cachedGoogleAuth) {
      const { GoogleOAuthWebAuth } = await import('./auth/google-oauth-web.ts');
      cachedGoogleAuth = new GoogleOAuthWebAuth({
        clientId: googleClientId,
        tokenHelperUrl,
        storage,
      });
    }
    return cachedGoogleAuth;
  };

  const createGoogleDriveTransport = async (): Promise<SyncTransport> => {
    if (!cachedDriveTransport) {
      const [auth, { GoogleDriveAppDataTransport }] = await Promise.all([
        getGoogleAuth(),
        import('./sync/google-drive-transport.ts'),
      ]);
      cachedDriveTransport = new GoogleDriveAppDataTransport({ auth });
    }
    return cachedDriveTransport;
  };

  const pickLocalSyncFolder = async (): Promise<{
    name: string;
    transport: SyncTransport;
  } | null> => {
    const { pickAndSaveLocalSyncFolder } = await import('./sync/local-folder-transport.ts');
    return pickAndSaveLocalSyncFolder(storage);
  };

  const restoreLocalSyncFolder = async (opts?: {
    requestPermission?: boolean;
  }): Promise<{ name: string; transport: SyncTransport } | null> => {
    const { restoreLocalSyncFolderHandle } = await import('./sync/local-folder-transport.ts');
    return restoreLocalSyncFolderHandle(storage, opts);
  };

  const disconnectLocalSyncFolder = async (): Promise<void> => {
    const { clearSavedLocalSyncFolder } = await import('./sync/local-folder-transport.ts');
    await clearSavedLocalSyncFolder(storage);
  };

  const createReplayWorker = async (): Promise<ReplayWorkerClient | null> => {
    const { createWebReplayWorker } = await import('./workers/replay-client.ts');
    return createWebReplayWorker();
  };

  return {
    deviceId: resolved.deviceId,
    deviceLabel: resolved.label,
    isDevMode,
    hasDeviceSlug: Boolean(resolved.slug),
    storage,
    files,
    syncTransport,
    googleOAuthConfigured,
    supportsLocalFolderSync,
    getGoogleAuth,
    createGoogleDriveTransport,
    pickLocalSyncFolder,
    restoreLocalSyncFolder,
    disconnectLocalSyncFolder,
    ...(devTransport
      ? {
          onDevSyncNotification: (listener: (path: string) => void) =>
            devTransport.subscribe(listener),
        }
      : {}),
    createReplayWorker,
  };
}
