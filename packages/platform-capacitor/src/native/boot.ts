import type { PlatformServices } from '@flash/platform';
import {
  composeNativePlatform,
  lazyDropboxFields,
  LazyHandwritingRecognizer,
  lazyOneDriveFields,
} from '@flash/platform-web/native-support';
import { webCryptoEd25519Provider } from '@flash/platform-web/purchase-license';
import { Capacitor } from '@capacitor/core';
import { CapacitorSqliteStorage, createCapacitorPlatform } from '../index.ts';
import { createSecureKvRouting } from '../secure/secure-kv-storage.ts';
import { withSecretLossDetection } from '../secure/secure-loss-tracking.ts';
import {
  clearPluginTokenCopiesAtLaunch,
  googleSignInCleanup,
  markStoredSecretsAtLaunch,
  prepareSecureStorageAtLaunch,
} from '../secure/secure-launch.ts';
import {
  DROPBOX_REFRESH_TOKEN_KEY,
  MICROSOFT_REFRESH_TOKEN_KEY,
  SECURE_KEYS_LOST_KV_KEY,
  SECURE_KV_KEYS,
  type MobilePlatform,
} from '../secure/secure-store.ts';
import {
  createAddDeviceUrlSource,
  createAndroidDeviceSpeech,
  createBackButtonSource,
  createFileBridge,
  createGoogleSignInPlugin,
  createICloudDocumentPlugin,
  createLocalNotificationsBridge,
  createMlKitInkPlugin,
  createNativeSecureStorage,
  createStoreBillingPlugin,
  createSystemBrowserLauncher,
  openCapacitorSqliteDriver,
  sweepCapacitorExportCache,
} from './plugins.ts';

export interface CapacitorBootConfig {
  /** Browser services (`createWebPlatform()`) reused inside the WebView. */
  base: PlatformServices;
  googleClientId?: string;
  googleIosClientId?: string;
  googleApiKey?: string;
  /** HTTPS URL of the hosted `picker.html` page opened in the system browser (§11). */
  pickerPageUrl?: string;
  isPersonalBuild: boolean;
  packCatalogUrl?: string;
  starterCatalogUrl?: string;
  /** Entra client ID for OneDrive (public client, `flashcards://oauth/microsoft` redirect). */
  microsoftClientId?: string;
  microsoftTenant?: string;
  /** Dropbox App Folder app key (public PKCE client, `flashcards://oauth/dropbox` redirect). */
  dropboxAppKey?: string;
  /** Ed25519 public key (hex) for offline licence keys (S12, `VITE_LICENSE_PUBLIC_KEY`). */
  licensePublicKeyHex?: string;
  /**
   * Accept licence keys bought outside the stores on this store build. Off unless the build sets
   * `VITE_STORE_LICENSE_KEYS=true`: store rules restrict it, so it is the owner's decision.
   */
  allowLicenseKeys?: boolean;
}

/** Memoizes an async loader; a failed attempt is forgotten so the next call retries. */
function retryableOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () =>
    (pending ??= load().catch((err: unknown) => {
      pending = null;
      throw err;
    }));
}

/**
 * Boots `PlatformServices` for the Capacitor Android / iOS shell with real native plugins.
 * Called by `apps/web/src/main.tsx` only when `Capacitor.isNativePlatform()` is true.
 *
 * On iOS, iCloud Drive sync uses the app's own Swift plugin (`ICloudDocumentsPlugin.swift`),
 * registered by `MainViewController`.
 *
 * Sign-in secrets (the Google and OneDrive sessions, the OneDrive refresh token and the BYO TTS key)
 * live only in the Keychain / Keystore (`@flash/capacitor-secure-storage`, §16), never in SQLite.
 */
export async function bootCapacitorPlatform(
  config: CapacitorBootConfig,
): Promise<PlatformServices> {
  const platformName = Capacitor.getPlatform();
  const mobilePlatform: MobilePlatform = platformName === 'ios' ? 'ios' : 'android';
  const database = new CapacitorSqliteStorage(await openCapacitorSqliteDriver());
  // The sign-in secrets were dropped (Android: the Keystore key was lost; iOS: the Keychain items
  // vanished, e.g. after a restore onto another device): leave a plain flag so the app can explain
  // once why the user has to sign in again (no secret in it).
  const onSecretsLost = () => database.setKv(SECURE_KEYS_LOST_KV_KEY, { at: Date.now() });
  const secureStorage = withSecretLossDetection(mobilePlatform, {
    store: createNativeSecureStorage(onSecretsLost),
    markers: database,
    onSecretsLost,
  });
  const secureKv = createSecureKvRouting({
    inner: database,
    secureStore: secureStorage,
    kvKeys: SECURE_KV_KEYS,
    extraSecretKeys: [MICROSOFT_REFRESH_TOKEN_KEY, DROPBOX_REFRESH_TOKEN_KEY],
  });
  await prepareSecureStorageAtLaunch({
    database,
    routing: secureKv,
    scrubFreePages: () => database.scrubFreePages(),
  });
  // In the background, so it never delays the first study screen.
  void markStoredSecretsAtLaunch({
    platform: mobilePlatform,
    secureStorage,
    keys: secureKv.secretKeys,
  });

  const googleSignInPlugin = await loadGoogleSignInPlugin(
    config,
    googleSignInCleanup(mobilePlatform, secureStorage),
  );

  const base = config.base;
  const native = createCapacitorPlatform({
    deviceId: `capacitor-${platformName}`,
    deviceLabel: platformName === 'ios' ? 'iPhone / iPad' : 'Android Device',
    storage: secureKv.storage,
    fileBridge: createFileBridge(),
    ...(platformName === 'android' ? { deviceSpeech: createAndroidDeviceSpeech() } : {}),
    ...(googleSignInPlugin ? { googleSignInPlugin } : {}),
    ...(config.googleClientId ? { googleClientId: config.googleClientId } : {}),
    pickerLauncher: createSystemBrowserLauncher(),
    ...(config.pickerPageUrl ? { pickerPageUrl: config.pickerPageUrl } : {}),
    ...(config.googleApiKey ? { googleApiKey: config.googleApiKey } : {}),
    mlKitPlugin: createMlKitInkPlugin(),
    ...(base.getHandwritingRecognizer
      ? { fallbackRecognizer: new LazyHandwritingRecognizer(base.getHandwritingRecognizer) }
      : {}),
    billingPlugin: createStoreBillingPlugin(),
    ...(config.licensePublicKeyHex ? { licensePublicKeyHex: config.licensePublicKeyHex } : {}),
    licenseCryptoProvider: webCryptoEd25519Provider,
    allowLicenseKeys: config.allowLicenseKeys === true,
    ...(platformName === 'ios' ? { iCloudPlugin: createICloudDocumentPlugin() } : {}),
    isPersonalBuild: config.isPersonalBuild,
    ...(config.packCatalogUrl ? { packCatalogUrl: config.packCatalogUrl } : {}),
    ...(config.starterCatalogUrl ? { starterCatalogUrl: config.starterCatalogUrl } : {}),
  });

  const loadOneDrive = oneDriveLoader(config, secureStorage, native.storage);
  const loadDropbox = dropboxLoader(config, secureStorage, native.storage);

  // In the background, so it never delays the first study screen.
  void clearPluginTokenCopiesAtLaunch({
    platform: mobilePlatform,
    secureStorage,
    storage: native.storage,
    ...(loadOneDrive ? { loadOneDrive } : {}),
    ...(loadDropbox ? { loadDropbox } : {}),
  }).catch((err: unknown) => {
    console.warn('Could not clear sign-in plugin token copies at launch:', err);
  });

  // Sweep leftover temporary export files from previous sessions in the background.
  void sweepCapacitorExportCache().catch(() => undefined);

  return {
    ...composeNativePlatform(native, base),
    onAddDeviceUrl: createAddDeviceUrlSource(),
    ...(platformName === 'android' ? { onBackButton: createBackButtonSource() } : {}),
    ...(loadOneDrive ? lazyOneDriveFields(loadOneDrive) : {}),
    ...(loadDropbox ? lazyDropboxFields(loadDropbox) : {}),
    // Phase 13 study reminders: OS local notifications (the PWA only shows an in-app badge).
    studyReminderDelivery: 'os-scheduled',
    getStudyReminderScheduler: async () => {
      const { createLocalNotificationReminderScheduler } =
        await import('../reminders/local-notification-reminders.ts');
      return createLocalNotificationReminderScheduler(createLocalNotificationsBridge());
    },
  };
}

/** The native Google sign-in plugin, or `undefined` when Google isn't configured or won't load. */
async function loadGoogleSignInPlugin(
  config: CapacitorBootConfig,
  afterLogin: ReturnType<typeof googleSignInCleanup>,
): Promise<Awaited<ReturnType<typeof createGoogleSignInPlugin>> | undefined> {
  if (!config.googleClientId) return undefined;
  try {
    return await createGoogleSignInPlugin({
      webClientId: config.googleClientId,
      ...(config.googleIosClientId ? { iOSClientId: config.googleIosClientId } : {}),
      ...(afterLogin ? { afterLogin } : {}),
    });
  } catch (err: unknown) {
    console.warn('Google Sign-In plugin unavailable:', err);
    return undefined;
  }
}

/** Lazily builds the OneDrive services (only when a Microsoft client id is configured). */
function oneDriveLoader(
  config: CapacitorBootConfig,
  secureStore: ReturnType<typeof createNativeSecureStorage>,
  storage: PlatformServices['storage'],
) {
  const clientId = config.microsoftClientId;
  if (!clientId) return undefined;
  return retryableOnce(async () => {
    const [{ createMicrosoftSocialLoginBridge }, { createNativeOneDriveServices }] =
      await Promise.all([
        import('./microsoft-social-login.ts'),
        import('@flash/platform-web/onedrive'),
      ]);
    return createNativeOneDriveServices({
      bridge: await createMicrosoftSocialLoginBridge({
        clientId,
        ...(config.microsoftTenant ? { tenant: config.microsoftTenant } : {}),
        secureStore,
      }),
      storage,
    });
  });
}

/** Lazily builds the Dropbox App Folder services (only when a Dropbox app key is configured). */
function dropboxLoader(
  config: CapacitorBootConfig,
  secureStore: ReturnType<typeof createNativeSecureStorage>,
  storage: PlatformServices['storage'],
) {
  const appKey = config.dropboxAppKey;
  if (!appKey) return undefined;
  return retryableOnce(async () => {
    const [{ createDropboxSocialLoginBridge }, { createNativeDropboxServices }] = await Promise.all(
      [import('./dropbox-social-login.ts'), import('@flash/platform-web/dropbox')],
    );
    return createNativeDropboxServices({
      bridge: await createDropboxSocialLoginBridge({
        appKey,
        secureStore,
      }),
      storage,
    });
  });
}
