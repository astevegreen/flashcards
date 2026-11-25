import type { PlatformServices, SyncTransport } from '@flash/platform';
import { WebDeviceSpeechPlayer } from './audio/device-speech.ts';
import { WebAudioPlayer } from './audio/web-audio-player.ts';
import { WebFiles } from './files/web-files.ts';
import type { LazyWebServices } from './lazy-services.ts';
import { loadOnceUntilFailure } from './load-once.ts';
import { DexieStorage } from './storage/dexie-storage.ts';

export { DexieStorage } from './storage/dexie-storage.ts';
export { WebFiles } from './files/web-files.ts';
export { WebAudioPlayer } from './audio/web-audio-player.ts';
export { WebDeviceSpeechPlayer, getMissingVoiceInstructions } from './audio/device-speech.ts';

export interface ResolvedDevice {
  slug?: string;
  deviceId: string;
  label: string;
}

export interface CreateWebPlatformOptions {
  isDevMode?: boolean;
  googleClientId?: string;
  tokenHelperUrl?: string;
  googleApiKey?: string;
  /** Dropbox app key for optional App Folder sync (public PKCE client, no secret). */
  dropboxAppKey?: string;
  /** Microsoft Entra client ID for OneDrive app-folder sync (code exchange via token helper). */
  microsoftClientId?: string;
  /** Entra authority tenant (default `consumers`: personal Microsoft accounts). */
  microsoftTenant?: string;
  packCatalogUrl?: string;
  starterCatalogUrl?: string;
  isPersonalBuild?: boolean;
  licensePublicKeyHex?: string;
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

/** A `SyncTransport` whose implementation is created on first use (keeps it out of the boot chunk). */
function lazySyncTransport(load: () => Promise<SyncTransport>): SyncTransport {
  const get = loadOnceUntilFailure(load);
  return {
    list: async (prefix) => (await get()).list(prefix),
    read: async (path) => (await get()).read(path),
    write: async (path, data, opts) => (await get()).write(path, data, opts),
  };
}

export function createWebPlatform(options?: CreateWebPlatformOptions): PlatformServices {
  const resolved = resolveDeviceFromUrl();
  const isDevMode = options?.isDevMode ?? Boolean(resolved.slug);
  const storage = new DexieStorage(resolved.slug);
  const files = new WebFiles();
  const audioPlayer = new WebAudioPlayer();
  const deviceSpeech = new WebDeviceSpeechPlayer();
  // The dev (`?device=`) and in-memory stub transports load on demand, outside the initial study
  // bundle (§8). In dev mode the import starts right away so its BroadcastChannel opens at boot.
  const loadTransports = () => import('./sync/in-memory-transport.ts');
  const devTransport = resolved.slug
    ? loadTransports().then((m) => new m.DevChannelSyncTransport())
    : null;
  const syncTransport: SyncTransport = lazySyncTransport(
    () => devTransport ?? loadTransports().then((m) => new m.InMemorySyncTransport()),
  );

  const googleClientId = options?.googleClientId?.trim() ?? '';
  const tokenHelperUrl = options?.tokenHelperUrl?.trim() ?? '';
  const googleApiKey = options?.googleApiKey?.trim() ?? '';
  const dropboxAppKey = options?.dropboxAppKey?.trim() ?? '';
  const microsoftClientId = options?.microsoftClientId?.trim() ?? '';
  const microsoftTenant = options?.microsoftTenant?.trim() ?? '';
  // OneDrive web sign-in always goes through the token helper (confidential client, §4.3).
  const oneDriveConfigured = Boolean(microsoftClientId && tokenHelperUrl);
  const packCatalogUrl = options?.packCatalogUrl?.trim() || (isDevMode ? '/packs/packs.json' : '');
  const starterCatalogUrl = options?.starterCatalogUrl?.trim() ?? '';
  // The token helper is optional: without it, Google access is renewed with a GIS tap (§4.3).
  const googleOAuthConfigured = Boolean(googleClientId);
  const googlePickerConfigured = Boolean(googleOAuthConfigured && googleApiKey);
  const supportsLocalFolderSync =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      'function';

  // Every other service loads `lazy-services.ts` on first use, which then loads that service's own
  // chunk: one boot-chunk entry instead of one per service (§8).
  const lazy = loadOnceUntilFailure(() =>
    import('./lazy-services.ts').then((m) =>
      m.createLazyWebServices({
        slug: resolved.slug,
        isDevMode,
        storage,
        googleClientId,
        tokenHelperUrl,
        googleApiKey,
        dropboxAppKey,
        microsoftClientId,
        microsoftTenant,
        packCatalogUrl,
        isPersonalBuild: options?.isPersonalBuild ?? true,
        licensePublicKeyHex: options?.licensePublicKeyHex,
      }),
    ),
  );
  /** A platform method that forwards to the lazily loaded service of the same name. */
  const defer = <K extends keyof LazyWebServices>(key: K): LazyWebServices[K] =>
    (async (...args: unknown[]) =>
      ((await lazy())[key] as (...a: unknown[]) => unknown)(...args)) as LazyWebServices[K];

  return {
    deviceId: resolved.deviceId,
    deviceLabel: resolved.label,
    isDevMode,
    hasDeviceSlug: Boolean(resolved.slug),
    storage,
    files,
    syncTransport,
    audioPlayer,
    deviceSpeech,
    googleOAuthConfigured,
    googlePickerConfigured,
    supportsLocalFolderSync,
    ...(packCatalogUrl ? { packCatalogUrl } : {}),
    ...(starterCatalogUrl ? { starterCatalogUrl } : {}),
    getGoogleAuth: defer('getGoogleAuth'),
    createGoogleDriveTransport: defer('createGoogleDriveTransport'),
    dropboxConfigured: Boolean(dropboxAppKey),
    getDropboxAuth: defer('getDropboxAuth'),
    createDropboxTransport: defer('createDropboxTransport'),
    getDropboxPicker: defer('getDropboxPicker'),
    oneDriveConfigured,
    getOneDriveAuth: defer('getOneDriveAuth'),
    createOneDriveTransport: defer('createOneDriveTransport'),
    getOneDrivePicker: defer('getOneDrivePicker'),
    getGooglePicker: defer('getGooglePicker'),
    getGoogleSourcesClient: defer('getGoogleSourcesClient'),
    getLocalFolderSources: defer('getLocalFolderSources'),
    getPackageFetcher: defer('getPackageFetcher'),
    pickLocalSyncFolder: defer('pickLocalSyncFolder'),
    restoreLocalSyncFolder: defer('restoreLocalSyncFolder'),
    disconnectLocalSyncFolder: defer('disconnectLocalSyncFolder'),
    ...(devTransport
      ? {
          onDevSyncNotification: (listener: (path: string) => void) => {
            let unsubscribe: (() => void) | undefined;
            let active = true;
            void devTransport.then((t) => {
              if (active) unsubscribe = t.subscribe(listener);
            });
            return () => {
              active = false;
              unsubscribe?.();
            };
          },
        }
      : {}),
    createReplayWorker: defer('createReplayWorker'),
    processImage: defer('processImage'),
    fetchAndCacheHttpsImage: defer('fetchAndCacheHttpsImage'),
    createTtsProvider: defer('createTtsProvider'),
    processAudio: defer('processAudio'),
    fetchAndCacheHttpsAudio: defer('fetchAndCacheHttpsAudio'),
    getPackManager: defer('getPackManager'),
    getStrokeDataProvider: defer('getStrokeDataProvider'),
    getHandwritingRecognizer: defer('getHandwritingRecognizer'),
    getDictionaryService: defer('getDictionaryService'),
    getPurchase: defer('getPurchase'),
    getFsrsOptimizer: defer('getFsrsOptimizer'),
    getAnkiPackageReader: defer('getAnkiPackageReader'),
  };
}
