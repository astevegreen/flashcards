import type {
  AudioPlayer,
  Auth,
  DeviceSpeechPlayer,
  DictionaryService,
  Files,
  GooglePickerAdapter,
  GoogleSourcesClient,
  HandwritingRecognizer,
  NativePickerBridge,
  PackageSubscriptionFetcher,
  PackManager,
  PlatformServices,
  StrokeDataProvider,
  SyncTransport,
} from '@flash/platform';
import { SyncTransportError } from '@flash/core';
import {
  CapacitorNativePickerBridge,
  ICloudDriveSyncTransport,
  type ICloudDocumentPlugin,
  type SystemBrowserLauncher,
} from '@flash/platform-capacitor';
import { TauriGoogleAuth, type TauriLoopbackOAuthPlugin } from './auth/tauri-google-auth.ts';
import { TauriDesktopLicensePurchase } from './purchase/desktop-license-purchase.ts';
import {
  TauriFolderSyncTransport,
  TauriLocalFolderWatcher,
  type TauriFsBridge,
} from './sources/tauri-fs-watcher.ts';
import { TauriSqliteStorage, type TauriSqlPluginDatabase } from './storage/tauri-sqlite-storage.ts';

export {
  createSqliteRefreshTokenStore,
  resolveRefreshTokenStore,
  type LegacyRefreshTokenStore,
  type RefreshTokenStorageMode,
  type RefreshTokenStore,
  type ResolvedRefreshTokenStore,
  type SecureSecretBackend,
} from './auth/refresh-token-store.ts';
export { TauriGoogleAuth, type TauriLoopbackOAuthPlugin } from './auth/tauri-google-auth.ts';
export {
  TauriDesktopLicensePurchase,
  type TauriDesktopLicenseOptions,
} from './purchase/desktop-license-purchase.ts';
export {
  TauriFolderSyncTransport,
  TauriLocalFolderWatcher,
  type TauriFsBridge,
  type TauriFsDirEntry,
} from './sources/tauri-fs-watcher.ts';
export { TauriSqliteStorage, type TauriSqlPluginDatabase } from './storage/tauri-sqlite-storage.ts';
export {
  createTauriICloudDocumentPlugin,
  probeICloudAvailable,
  resolveTauriICloudOptions,
  type TauriICloudOptions,
  type TauriInvoke,
} from './sync/tauri-icloud-bridge.ts';

export interface CreateTauriPlatformOptions {
  deviceId: string;
  deviceLabel?: string;
  sqlDb?: TauriSqlPluginDatabase;
  fsBridge?: TauriFsBridge;
  oauthPlugin?: TauriLoopbackOAuthPlugin;
  googleClientId?: string;
  pickerLauncher?: SystemBrowserLauncher;
  pickerPageUrl?: string;
  googleApiKey?: string;
  isPersonalBuild?: boolean;
  licensePublicKeyHex?: string;
  createDriveTransport?: (auth: Auth) => Promise<SyncTransport>;
  files?: Files;
  audioPlayer?: AudioPlayer;
  deviceSpeech?: DeviceSpeechPlayer;
  googleSourcesClient?: GoogleSourcesClient;
  packageFetcher?: PackageSubscriptionFetcher;
  packManager?: PackManager;
  strokeDataProvider?: StrokeDataProvider;
  handwritingRecognizer?: HandwritingRecognizer;
  dictionaryService?: DictionaryService;
  packCatalogUrl?: string;
  starterCatalogUrl?: string;
  /**
   * macOS iCloud Drive file I/O (createTauriICloudDocumentPlugin), always passed on a Mac build
   * that has the iCloud entitlement, so a saved iCloud connection keeps working; availability is
   * checked on each connect. Never passed on an unsigned build (no iCloud container).
   */
  iCloudPlugin?: ICloudDocumentPlugin;
  /** False when iCloud was not available at launch: still offered, but not the default. */
  iCloudAvailableAtLaunch?: boolean;
  /** Set when sign-in secrets could not be kept in the OS keychain. */
  secureStorageWarning?: string;
}

/** Spreads an optional service getter only when the service was injected. */
function withGetter<T, R extends object>(value: T | undefined, build: (v: T) => R): R | object {
  return value === undefined ? {} : build(value);
}

/**
 * Creates a Tauri desktop (Windows / macOS / Linux) `PlatformServices` bundle (§10.1, §11, §15 Phase 8).
 */
export function createTauriPlatform(options: CreateTauriPlatformOptions): PlatformServices {
  const storage = new TauriSqliteStorage(options.sqlDb);
  const localFolderSources = new TauriLocalFolderWatcher({
    storage,
    ...(options.fsBridge ? { bridge: options.fsBridge } : {}),
  });
  const googleAuth = new TauriGoogleAuth({
    storage,
    ...(options.oauthPlugin ? { plugin: options.oauthPlugin } : {}),
    ...(options.googleClientId ? { clientId: options.googleClientId } : {}),
  });
  const pickerBridge: NativePickerBridge = new CapacitorNativePickerBridge(options.pickerLauncher);
  const purchase = new TauriDesktopLicensePurchase({
    storage,
    isPersonalBuild: options.isPersonalBuild ?? true,
    ...(options.licensePublicKeyHex ? { publicKeyHex: options.licensePublicKeyHex } : {}),
  });

  const files: Files = options.files ?? {
    pickFile: async () => null,
    downloadFile: async () => {
      throw new Error('Inject Tauri dialog/fs file saver.');
    },
    pickDirectory: async () => (options.fsBridge ? options.fsBridge.pickDirectory() : null),
  };

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
    deviceLabel: options.deviceLabel ?? 'Desktop App',
    isDevMode: false,
    hasDeviceSlug: false,
    storage,
    files,
    syncTransport,
    ...(options.audioPlayer ? { audioPlayer: options.audioPlayer } : {}),
    ...(options.deviceSpeech ? { deviceSpeech: options.deviceSpeech } : {}),
    googleOAuthConfigured: googleAuth.isConfigured(),
    googlePickerConfigured: Boolean(options.pickerPageUrl && options.googleApiKey),
    supportsLocalFolderSync: Boolean(options.fsBridge),
    ...(iCloudPlugin
      ? {
          iCloudSyncSupported: true,
          ...(options.iCloudAvailableAtLaunch === undefined
            ? {}
            : { iCloudAvailableAtLaunch: options.iCloudAvailableAtLaunch }),
          createICloudTransport: async (): Promise<SyncTransport> => {
            if (iCloudPlugin.isAvailable && !(await iCloudPlugin.isAvailable())) {
              throw new SyncTransportError(
                'AUTH_REQUIRED',
                'iCloud Drive is off. Sign in to iCloud in System Settings and turn on iCloud Drive.',
              );
            }
            return new ICloudDriveSyncTransport(iCloudPlugin);
          },
        }
      : {}),
    ...(options.secureStorageWarning ? { secureStorageWarning: options.secureStorageWarning } : {}),
    ...(options.packCatalogUrl ? { packCatalogUrl: options.packCatalogUrl } : {}),
    ...(options.starterCatalogUrl ? { starterCatalogUrl: options.starterCatalogUrl } : {}),
    getGoogleAuth: async () => googleAuth,
    createGoogleDriveTransport: async () => {
      if (options.createDriveTransport) {
        return options.createDriveTransport(googleAuth);
      }
      throw new Error('Provide createDriveTransport for Google Drive sync.');
    },
    getGooglePicker: async (): Promise<GooglePickerAdapter> => ({
      isConfigured: () => Boolean(options.pickerPageUrl && options.googleApiKey),
      pickSheetsAndDocs: async () => {
        if (!options.pickerPageUrl || !options.googleApiKey) {
          throw new Error('Google Picker page URL and API key are required.');
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
      throw new Error('Inject WebGoogleSourcesClient for Google Sheets/Docs pulls.');
    },
    getLocalFolderSources: async () => localFolderSources,
    getPackageFetcher: async (): Promise<PackageSubscriptionFetcher> => {
      if (options.packageFetcher) return options.packageFetcher;
      throw new Error('Inject WebPackageSubscriptionFetcher for HTTPS package fetches.');
    },
    pickLocalSyncFolder: async () => {
      if (!options.fsBridge) return null;
      const picked = await options.fsBridge.pickDirectory();
      if (!picked) return null;
      await storage.setKv('tauri_sync_folder_v1', picked);
      return {
        name: picked.name,
        transport: new TauriFolderSyncTransport(picked.path, options.fsBridge),
      };
    },
    restoreLocalSyncFolder: async () => {
      if (!options.fsBridge) return null;
      const saved = await storage.getKv<{ path: string; name: string }>('tauri_sync_folder_v1');
      if (!saved) return null;
      return {
        name: saved.name,
        transport: new TauriFolderSyncTransport(saved.path, options.fsBridge),
      };
    },
    disconnectLocalSyncFolder: async () => {
      await storage.deleteKv('tauri_sync_folder_v1');
    },
    ...withGetter(options.packManager, (v) => ({ getPackManager: async () => v })),
    ...withGetter(options.strokeDataProvider, (v) => ({ getStrokeDataProvider: async () => v })),
    ...withGetter(options.handwritingRecognizer, (v) => ({
      getHandwritingRecognizer: async () => v,
    })),
    ...withGetter(options.dictionaryService, (v) => ({ getDictionaryService: async () => v })),
    getPurchase: async () => purchase,
    getNativePickerBridge: async () => pickerBridge,
  };
}
