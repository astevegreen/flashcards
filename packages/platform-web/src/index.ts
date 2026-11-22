import type {
  Auth,
  DictionaryService,
  GooglePickerAdapter,
  GoogleSourcesClient,
  HandwritingRecognizer,
  LocalFolderSourcesAdapter,
  PackageSubscriptionFetcher,
  PackManager,
  PlatformServices,
  Purchase,
  ReplayWorkerClient,
  StrokeDataProvider,
  SyncTransport,
} from '@flash/platform';
import { WebDeviceSpeechPlayer } from './audio/device-speech.ts';
import { WebAudioPlayer } from './audio/web-audio-player.ts';
import { WebFiles } from './files/web-files.ts';
import type { DexiePackStorage } from './packs/dexie-pack-storage.ts';
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
  let pending: Promise<SyncTransport> | undefined;
  const get = () => (pending ??= load());
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
  const packCatalogUrl = options?.packCatalogUrl?.trim() || (isDevMode ? '/packs/packs.json' : '');
  const starterCatalogUrl = options?.starterCatalogUrl?.trim() ?? '';
  // The token helper is optional: without it, Google access is renewed with a GIS tap (§4.3).
  const googleOAuthConfigured = Boolean(googleClientId);
  const googlePickerConfigured = Boolean(googleOAuthConfigured && googleApiKey);
  const supportsLocalFolderSync =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      'function';

  let cachedGoogleAuth: Auth | null = null;
  let cachedDriveTransport: SyncTransport | null = null;
  let cachedDropboxAuth: Auth | null = null;
  let cachedDropboxTransport: SyncTransport | null = null;
  let cachedGooglePicker: GooglePickerAdapter | null = null;
  let cachedGoogleSources: GoogleSourcesClient | null = null;
  let cachedLocalFolderSources: LocalFolderSourcesAdapter | null = null;
  let cachedPackageFetcher: PackageSubscriptionFetcher | null = null;
  let cachedPackStoragePromise: Promise<DexiePackStorage> | null = null;
  let cachedPackManager: PackManager | null = null;
  let cachedStrokeProvider: StrokeDataProvider | null = null;
  let cachedHandwritingRecognizer: HandwritingRecognizer | null = null;
  let cachedDictionaryService: DictionaryService | null = null;
  let cachedPurchase: Purchase | null = null;

  const getPackStorage = async () => {
    if (!cachedPackStoragePromise) {
      cachedPackStoragePromise = import('./packs/dexie-pack-storage.ts').then(
        ({ DexiePackStorage }) => new DexiePackStorage(resolved.slug),
      );
    }
    return cachedPackStoragePromise;
  };

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

  const getDropboxAuth = async (): Promise<Auth> => {
    if (!cachedDropboxAuth) {
      const { DropboxOAuthWebAuth } = await import('./auth/dropbox-oauth-web.ts');
      cachedDropboxAuth = new DropboxOAuthWebAuth({ appKey: dropboxAppKey, storage });
    }
    return cachedDropboxAuth;
  };

  const createDropboxTransport = async (): Promise<SyncTransport> => {
    if (!cachedDropboxTransport) {
      const [auth, { DropboxAppFolderTransport }] = await Promise.all([
        getDropboxAuth(),
        import('./sync/dropbox-transport.ts'),
      ]);
      cachedDropboxTransport = new DropboxAppFolderTransport({
        getAccessToken: () => auth.getValidAccessToken(),
      });
    }
    return cachedDropboxTransport;
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

  const getGooglePicker = async (): Promise<GooglePickerAdapter> => {
    if (!cachedGooglePicker) {
      const [auth, { WebGooglePicker }] = await Promise.all([
        getGoogleAuth(),
        import('./sources/google-picker.ts'),
      ]);
      cachedGooglePicker = new WebGooglePicker({
        auth,
        apiKey: googleApiKey,
        clientId: googleClientId,
      });
    }
    return cachedGooglePicker;
  };

  const getGoogleSourcesClient = async (): Promise<GoogleSourcesClient> => {
    if (!cachedGoogleSources) {
      const [auth, { WebGoogleSourcesClient }] = await Promise.all([
        getGoogleAuth(),
        import('./sources/google-sheets-docs.ts'),
      ]);
      cachedGoogleSources = new WebGoogleSourcesClient({ auth });
    }
    return cachedGoogleSources;
  };

  const getLocalFolderSources = async (): Promise<LocalFolderSourcesAdapter> => {
    if (!cachedLocalFolderSources) {
      const { WebLocalFolderSources } = await import('./sources/local-folder-sources.ts');
      cachedLocalFolderSources = new WebLocalFolderSources({ storage });
    }
    return cachedLocalFolderSources;
  };

  const getPackageFetcher = async (): Promise<PackageSubscriptionFetcher> => {
    if (!cachedPackageFetcher) {
      const { WebPackageSubscriptionFetcher } = await import('./sources/package-subscription.ts');
      cachedPackageFetcher = new WebPackageSubscriptionFetcher();
    }
    return cachedPackageFetcher;
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

  const processImage: NonNullable<PlatformServices['processImage']> = async (bytes, mime, opts) => {
    const { processImageBytes } = await import('./media/image-processor.ts');
    return processImageBytes(bytes, mime, opts);
  };

  const fetchAndCacheHttpsImage: NonNullable<PlatformServices['fetchAndCacheHttpsImage']> = async (
    url,
    opts,
  ) => {
    const { fetchAndProcessHttpsImage } = await import('./media/image-processor.ts');
    return fetchAndProcessHttpsImage(url, opts);
  };

  const createTtsProvider: NonNullable<PlatformServices['createTtsProvider']> = async (config) => {
    const { createWebTtsProvider } = await import('./audio/tts-providers.ts');
    return createWebTtsProvider(config);
  };

  const processAudio: NonNullable<PlatformServices['processAudio']> = async (bytes, mime) => {
    const { processAudioBytes } = await import('./media/audio-processor.ts');
    return processAudioBytes(bytes, mime);
  };

  const fetchAndCacheHttpsAudio: NonNullable<PlatformServices['fetchAndCacheHttpsAudio']> = async (
    url,
  ) => {
    const { fetchAndProcessHttpsAudio } = await import('./media/audio-processor.ts');
    return fetchAndProcessHttpsAudio(url);
  };

  const getPackManager = async (): Promise<PackManager> => {
    if (!cachedPackManager) {
      const [packStorage, { WebPackManager }] = await Promise.all([
        getPackStorage(),
        import('./packs/web-pack-manager.ts'),
      ]);
      cachedPackManager = new WebPackManager({
        packStorage,
        ...(packCatalogUrl ? { defaultCatalogUrl: packCatalogUrl } : {}),
        allowRelativeUrls: isDevMode || packCatalogUrl.startsWith('/'),
      });
    }
    return cachedPackManager;
  };

  const getStrokeDataProvider = async (): Promise<StrokeDataProvider> => {
    if (!cachedStrokeProvider) {
      const [packStorage, packManager, { WebStrokeDataProvider }] = await Promise.all([
        getPackStorage(),
        getPackManager(),
        import('./drawing/web-stroke-provider.ts'),
      ]);
      cachedStrokeProvider = new WebStrokeDataProvider({
        packStorage,
        packManager,
        allowRelativeUrls: isDevMode || packCatalogUrl.startsWith('/'),
      });
    }
    return cachedStrokeProvider;
  };

  const getHandwritingRecognizer = async (): Promise<HandwritingRecognizer> => {
    if (!cachedHandwritingRecognizer) {
      const [packStorage, { WebStrokeRecognizer }] = await Promise.all([
        getPackStorage(),
        import('./drawing/web-stroke-recognizer.ts'),
      ]);
      cachedHandwritingRecognizer = new WebStrokeRecognizer(packStorage);
    }
    return cachedHandwritingRecognizer;
  };

  const getDictionaryService = async (): Promise<DictionaryService> => {
    if (!cachedDictionaryService) {
      const [packStorage, { WebDictionaryService }] = await Promise.all([
        getPackStorage(),
        import('./dictionary/web-dictionary-service.ts'),
      ]);
      cachedDictionaryService = new WebDictionaryService(packStorage);
    }
    return cachedDictionaryService;
  };

  const getPurchase = async (): Promise<Purchase> => {
    if (!cachedPurchase) {
      const { WebLicensePurchase } = await import('./purchase/web-license-purchase.ts');
      cachedPurchase = new WebLicensePurchase({
        storage,
        isPersonalBuild: options?.isPersonalBuild ?? true,
        ...(options?.licensePublicKeyHex ? { publicKeyHex: options.licensePublicKeyHex } : {}),
      });
    }
    return cachedPurchase;
  };

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
    getGoogleAuth,
    createGoogleDriveTransport,
    dropboxConfigured: Boolean(dropboxAppKey),
    getDropboxAuth,
    createDropboxTransport,
    getGooglePicker,
    getGoogleSourcesClient,
    getLocalFolderSources,
    getPackageFetcher,
    pickLocalSyncFolder,
    restoreLocalSyncFolder,
    disconnectLocalSyncFolder,
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
    createReplayWorker,
    processImage,
    fetchAndCacheHttpsImage,
    createTtsProvider,
    processAudio,
    fetchAndCacheHttpsAudio,
    getPackManager,
    getStrokeDataProvider,
    getHandwritingRecognizer,
    getDictionaryService,
    getPurchase,
  };
}
