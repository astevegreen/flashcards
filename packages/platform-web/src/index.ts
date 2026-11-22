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
import { DevChannelSyncTransport, InMemorySyncTransport } from './sync/in-memory-transport.ts';

export { DexieStorage } from './storage/dexie-storage.ts';
export { WebFiles } from './files/web-files.ts';
export { DevChannelSyncTransport, InMemorySyncTransport } from './sync/in-memory-transport.ts';
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

export function createWebPlatform(options?: CreateWebPlatformOptions): PlatformServices {
  const resolved = resolveDeviceFromUrl();
  const isDevMode = options?.isDevMode ?? Boolean(resolved.slug);
  const storage = new DexieStorage(resolved.slug);
  const files = new WebFiles();
  const audioPlayer = new WebAudioPlayer();
  const deviceSpeech = new WebDeviceSpeechPlayer();
  const devTransport = resolved.slug ? new DevChannelSyncTransport() : null;
  const syncTransport: SyncTransport = devTransport ?? new InMemorySyncTransport();

  const googleClientId = options?.googleClientId?.trim() ?? '';
  const tokenHelperUrl = options?.tokenHelperUrl?.trim() ?? '';
  const googleApiKey = options?.googleApiKey?.trim() ?? '';
  const packCatalogUrl = options?.packCatalogUrl?.trim() || (isDevMode ? '/packs/packs.json' : '');
  const starterCatalogUrl = options?.starterCatalogUrl?.trim() ?? '';
  const googleOAuthConfigured = Boolean(googleClientId && tokenHelperUrl);
  const googlePickerConfigured = Boolean(googleOAuthConfigured && googleApiKey);
  const supportsLocalFolderSync =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      'function';

  let cachedGoogleAuth: Auth | null = null;
  let cachedDriveTransport: SyncTransport | null = null;
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
    getGooglePicker,
    getGoogleSourcesClient,
    getLocalFolderSources,
    getPackageFetcher,
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
