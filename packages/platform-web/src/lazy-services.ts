import type {
  Auth,
  DictionaryService,
  AnkiPackageReader,
  FsrsOptimizer,
  GooglePickerAdapter,
  GoogleSourcesClient,
  HandwritingRecognizer,
  LocalFolderSourcesAdapter,
  OneDriveFilePicker,
  PackageSubscriptionFetcher,
  PackManager,
  PlatformServices,
  Purchase,
  ReplayWorkerClient,
  StrokeDataProvider,
  SyncTransport,
} from '@flash/platform';
import type { OneDriveServices } from './onedrive-services.ts';
import type { DexiePackStorage } from './packs/dexie-pack-storage.ts';
import type { DexieStorage } from './storage/dexie-storage.ts';

/** What `createWebPlatform` resolved at boot that the on-demand services need. */
export interface LazyWebServicesContext {
  slug: string | undefined;
  isDevMode: boolean;
  storage: DexieStorage;
  googleClientId: string;
  tokenHelperUrl: string;
  googleApiKey: string;
  dropboxAppKey: string;
  microsoftClientId: string;
  microsoftTenant: string;
  packCatalogUrl: string;
  isPersonalBuild: boolean;
  licensePublicKeyHex: string | undefined;
}

/**
 * The web platform's on-demand services. `createWebPlatform` loads this module on the first call
 * to any of them, so their factories and per-feature `import()` calls stay out of the initial
 * study-screen chunk (§8). Each service still loads its own implementation chunk on first use.
 */
export function createLazyWebServices(ctx: LazyWebServicesContext) {
  const {
    slug,
    isDevMode,
    storage,
    googleClientId,
    tokenHelperUrl,
    googleApiKey,
    dropboxAppKey,
    microsoftClientId,
    microsoftTenant,
    packCatalogUrl,
  } = ctx;

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
        ({ DexiePackStorage }) => new DexiePackStorage(slug),
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

  let oneDriveServices: Promise<OneDriveServices> | null = null;
  const loadOneDrive = () =>
    (oneDriveServices ??= import('./onedrive-services.ts').then((m) =>
      m.createOneDriveWebServices({
        clientId: microsoftClientId,
        tokenHelperUrl,
        ...(microsoftTenant ? { tenant: microsoftTenant } : {}),
        storage,
      }),
    ));

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
      // Sharded packs fetch their shards from beside the pack index (same URL rules as installs).
      cachedDictionaryService = new WebDictionaryService(packStorage, {
        allowRelativeUrls: isDevMode || packCatalogUrl.startsWith('/'),
      });
    }
    return cachedDictionaryService;
  };

  const getFsrsOptimizer = async (): Promise<FsrsOptimizer> => {
    const { createWebFsrsOptimizer } = await import('./fsrs/web-fsrs-optimizer.ts');
    return createWebFsrsOptimizer();
  };

  const getAnkiPackageReader = async (): Promise<AnkiPackageReader> => {
    const { createWebAnkiPackageReader } = await import('./anki/web-anki-reader.ts');
    return createWebAnkiPackageReader();
  };

  const getPurchase = async (): Promise<Purchase> => {
    if (!cachedPurchase) {
      const { WebLicensePurchase } = await import('./purchase/web-license-purchase.ts');
      cachedPurchase = new WebLicensePurchase({
        storage,
        isPersonalBuild: ctx.isPersonalBuild,
        ...(ctx.licensePublicKeyHex ? { publicKeyHex: ctx.licensePublicKeyHex } : {}),
      });
    }
    return cachedPurchase;
  };

  return {
    getGoogleAuth,
    createGoogleDriveTransport,
    getDropboxAuth,
    createDropboxTransport,
    getOneDriveAuth: async (): Promise<Auth> => (await loadOneDrive()).auth,
    createOneDriveTransport: async (): Promise<SyncTransport> => (await loadOneDrive()).transport,
    getOneDrivePicker: async (): Promise<OneDriveFilePicker> => (await loadOneDrive()).picker,
    getGooglePicker,
    getGoogleSourcesClient,
    getLocalFolderSources,
    getPackageFetcher,
    pickLocalSyncFolder,
    restoreLocalSyncFolder,
    disconnectLocalSyncFolder,
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
    getFsrsOptimizer,
    getAnkiPackageReader,
  };
}

export type LazyWebServices = ReturnType<typeof createLazyWebServices>;
