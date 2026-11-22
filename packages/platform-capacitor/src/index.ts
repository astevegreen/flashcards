import type {
  AudioPlayer,
  Auth,
  DeviceSpeechPlayer,
  DictionaryService,
  GooglePickerAdapter,
  GoogleSourcesClient,
  HandwritingRecognizer,
  LocalFolderSourcesAdapter,
  NativePickerBridge,
  PackageSubscriptionFetcher,
  PackManager,
  PlatformServices,
  Purchase,
  StrokeDataProvider,
  SyncTransport,
} from '@flash/platform';
import { SyncTransportError } from '@flash/core';
import { CapacitorGoogleAuth, type NativeGoogleSignInPlugin } from './auth/native-google-auth.ts';
import {
  CapacitorMlKitInkRecognizer,
  type MlKitDigitalInkPlugin,
} from './drawing/mlkit-ink-recognizer.ts';
import { CapacitorFiles, type CapacitorFileBridge } from './files/capacitor-files.ts';
import { CapacitorStorePurchase, type StoreBillingPlugin } from './purchase/store-purchase.ts';
import {
  CapacitorNativePickerBridge,
  type SystemBrowserLauncher,
} from './sources/native-picker-bridge.ts';
import {
  CapacitorSqliteStorage,
  InMemorySqliteDriver,
  type SqliteDriver,
} from './storage/sqlite-storage.ts';
import { ICloudDriveSyncTransport, type ICloudDocumentPlugin } from './sync/icloud-transport.ts';

export { CapacitorGoogleAuth, type NativeGoogleSignInPlugin } from './auth/native-google-auth.ts';
export {
  CapacitorMlKitInkRecognizer,
  type MlKitDigitalInkPlugin,
} from './drawing/mlkit-ink-recognizer.ts';
export { CapacitorFiles, type CapacitorFileBridge } from './files/capacitor-files.ts';
export { CapacitorStorePurchase, type StoreBillingPlugin } from './purchase/store-purchase.ts';
export {
  CapacitorNativePickerBridge,
  type SystemBrowserLauncher,
} from './sources/native-picker-bridge.ts';
export {
  CapacitorSqliteStorage,
  InMemorySqliteDriver,
  type SqliteDriver,
} from './storage/sqlite-storage.ts';
export { ICloudDriveSyncTransport, type ICloudDocumentPlugin } from './sync/icloud-transport.ts';

export interface CreateCapacitorPlatformOptions {
  deviceId: string;
  deviceLabel?: string;
  sqliteDriver?: SqliteDriver;
  fileBridge?: CapacitorFileBridge;
  googleSignInPlugin?: NativeGoogleSignInPlugin;
  googleClientId?: string;
  pickerLauncher?: SystemBrowserLauncher;
  pickerPageUrl?: string;
  googleApiKey?: string;
  mlKitPlugin?: MlKitDigitalInkPlugin;
  fallbackRecognizer?: HandwritingRecognizer;
  billingPlugin?: StoreBillingPlugin;
  iCloudPlugin?: ICloudDocumentPlugin;
  isPersonalBuild?: boolean;
  createDriveTransport?: (auth: Auth) => Promise<SyncTransport>;
  audioPlayer?: AudioPlayer;
  deviceSpeech?: DeviceSpeechPlayer;
  googleSourcesClient?: GoogleSourcesClient;
  packageFetcher?: PackageSubscriptionFetcher;
  packManager?: PackManager;
  strokeDataProvider?: StrokeDataProvider;
  dictionaryService?: DictionaryService;
  packCatalogUrl?: string;
  starterCatalogUrl?: string;
}

/** Spreads an optional service getter only when the service was injected. */
function withGetter<T, R extends object>(value: T | undefined, build: (v: T) => R): R | object {
  return value === undefined ? {} : build(value);
}

/**
 * Creates a Capacitor (Android / iOS) `PlatformServices` bundle (§10.1, §11, §15 Phase 8).
 */
export function createCapacitorPlatform(options: CreateCapacitorPlatformOptions): PlatformServices {
  const storage = new CapacitorSqliteStorage(options.sqliteDriver ?? new InMemorySqliteDriver());
  const files = new CapacitorFiles(options.fileBridge);
  const googleAuth = new CapacitorGoogleAuth({
    storage,
    ...(options.googleSignInPlugin ? { plugin: options.googleSignInPlugin } : {}),
    ...(options.googleClientId ? { clientId: options.googleClientId } : {}),
  });
  const pickerBridge: NativePickerBridge = new CapacitorNativePickerBridge(options.pickerLauncher);
  const recognizer = new CapacitorMlKitInkRecognizer({
    ...(options.mlKitPlugin ? { plugin: options.mlKitPlugin } : {}),
    ...(options.fallbackRecognizer ? { fallback: options.fallbackRecognizer } : {}),
  });
  const purchase: Purchase = new CapacitorStorePurchase({
    storage,
    isPersonalBuild: options.isPersonalBuild ?? false,
    ...(options.billingPlugin ? { billingPlugin: options.billingPlugin } : {}),
  });
  const syncTransport: SyncTransport = {
    list: async () => [],
    read: async () => {
      throw new Error('No sync transport connected yet.');
    },
    write: async () => {
      throw new Error('No sync transport connected yet.');
    },
  };
  const iCloudPlugin = options.iCloudPlugin;

  return {
    deviceId: options.deviceId,
    deviceLabel: options.deviceLabel ?? 'Mobile Device',
    isDevMode: false,
    hasDeviceSlug: false,
    storage,
    files,
    syncTransport,
    ...(options.audioPlayer ? { audioPlayer: options.audioPlayer } : {}),
    ...(options.deviceSpeech ? { deviceSpeech: options.deviceSpeech } : {}),
    googleOAuthConfigured: googleAuth.isConfigured(),
    googlePickerConfigured: Boolean(options.pickerPageUrl && options.googleApiKey),
    supportsLocalFolderSync: false,
    ...(iCloudPlugin
      ? {
          iCloudSyncSupported: true,
          createICloudTransport: async (): Promise<SyncTransport> => {
            if (iCloudPlugin.isAvailable && !(await iCloudPlugin.isAvailable())) {
              throw new SyncTransportError(
                'AUTH_REQUIRED',
                'iCloud Drive is off. Sign in to iCloud and turn on iCloud Drive for Flashcards in the Settings app.',
              );
            }
            return new ICloudDriveSyncTransport(iCloudPlugin);
          },
        }
      : {}),
    ...(options.packCatalogUrl ? { packCatalogUrl: options.packCatalogUrl } : {}),
    ...(options.starterCatalogUrl ? { starterCatalogUrl: options.starterCatalogUrl } : {}),
    getGoogleAuth: async () => googleAuth,
    createGoogleDriveTransport: async () => {
      if (options.createDriveTransport) {
        return options.createDriveTransport(googleAuth);
      }
      throw new Error('Provide createDriveTransport for Google Drive appDataFolder sync.');
    },
    getGooglePicker: async (): Promise<GooglePickerAdapter> => ({
      isConfigured: () => Boolean(options.pickerPageUrl && options.googleApiKey),
      pickSheetsAndDocs: async () => {
        if (!options.pickerPageUrl || !options.googleApiKey) {
          throw new Error('Native Google Picker page URL and API key are required.');
        }
        const token = await googleAuth.getValidAccessToken();
        return pickerBridge.openSystemBrowserPicker({
          pickerPageUrl: options.pickerPageUrl,
          accessToken: token,
          appId: options.googleClientId?.split('-')[0] ?? '',
          apiKey: options.googleApiKey,
        });
      },
    }),
    getGoogleSourcesClient: async (): Promise<GoogleSourcesClient> => {
      if (options.googleSourcesClient) return options.googleSourcesClient;
      throw new Error('Inject WebGoogleSourcesClient or native HTTP source client.');
    },
    getLocalFolderSources: async (): Promise<LocalFolderSourcesAdapter> => {
      throw new Error('Local folder sources are desktop/PC-only.');
    },
    getPackageFetcher: async (): Promise<PackageSubscriptionFetcher> => {
      if (options.packageFetcher) return options.packageFetcher;
      throw new Error('Inject WebPackageSubscriptionFetcher for HTTPS package fetches.');
    },
    pickLocalSyncFolder: async () => null,
    restoreLocalSyncFolder: async () => null,
    disconnectLocalSyncFolder: async () => undefined,
    ...withGetter(options.packManager, (v) => ({ getPackManager: async () => v })),
    ...withGetter(options.strokeDataProvider, (v) => ({ getStrokeDataProvider: async () => v })),
    getHandwritingRecognizer: async () => recognizer,
    ...withGetter(options.dictionaryService, (v) => ({ getDictionaryService: async () => v })),
    getPurchase: async () => purchase,
    getNativePickerBridge: async () => pickerBridge,
  };
}
