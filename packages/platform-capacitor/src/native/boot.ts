import type { PlatformServices } from '@flash/platform';
import {
  composeNativePlatform,
  LazyHandwritingRecognizer,
  lazyOneDriveFields,
} from '@flash/platform-web/native-support';
import { Capacitor } from '@capacitor/core';
import { CapacitorSqliteStorage, createCapacitorPlatform } from '../index.ts';
import { createSecureKvRouting } from '../secure/secure-kv-storage.ts';
import {
  clearPluginTokenCopiesAtLaunch,
  prepareSecureStorageAtLaunch,
} from '../secure/secure-launch.ts';
import {
  MICROSOFT_REFRESH_TOKEN_KEY,
  SECURE_KV_KEYS,
  SOCIAL_LOGIN_GOOGLE_ANDROID_COPY,
  type MobilePlatform,
} from '../secure/secure-store.ts';
import {
  createFileBridge,
  createGoogleSignInPlugin,
  createICloudDocumentPlugin,
  createLocalNotificationsBridge,
  createMlKitInkPlugin,
  createNativeSecureStorage,
  createStoreBillingPlugin,
  createSystemBrowserLauncher,
  openCapacitorSqliteDriver,
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
  const secureStorage = createNativeSecureStorage();
  const secureKv = createSecureKvRouting({
    inner: database,
    secureStore: secureStorage,
    kvKeys: SECURE_KV_KEYS,
    extraSecretKeys: [MICROSOFT_REFRESH_TOKEN_KEY],
  });
  await prepareSecureStorageAtLaunch({ database, routing: secureKv });

  const googleSignInPlugin = config.googleClientId
    ? await createGoogleSignInPlugin({
        webClientId: config.googleClientId,
        ...(config.googleIosClientId ? { iOSClientId: config.googleIosClientId } : {}),
        ...(mobilePlatform === 'android'
          ? {
              afterLogin: () =>
                secureStorage.removeLegacyPreference(SOCIAL_LOGIN_GOOGLE_ANDROID_COPY),
            }
          : {}),
      }).catch((err: unknown) => {
        console.warn('Google Sign-In plugin unavailable:', err);
        return undefined;
      })
    : undefined;

  const base = config.base;
  const native = createCapacitorPlatform({
    deviceId: `capacitor-${platformName}`,
    deviceLabel: platformName === 'ios' ? 'iPhone / iPad' : 'Android Device',
    storage: secureKv.storage,
    fileBridge: createFileBridge(),
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
    ...(platformName === 'ios' ? { iCloudPlugin: createICloudDocumentPlugin() } : {}),
    isPersonalBuild: config.isPersonalBuild,
    ...(config.packCatalogUrl ? { packCatalogUrl: config.packCatalogUrl } : {}),
    ...(config.starterCatalogUrl ? { starterCatalogUrl: config.starterCatalogUrl } : {}),
  });

  const microsoftClientId = config.microsoftClientId;
  const loadOneDrive = microsoftClientId
    ? retryableOnce(async () => {
        const [{ createMicrosoftSocialLoginBridge }, { createNativeOneDriveServices }] =
          await Promise.all([
            import('./microsoft-social-login.ts'),
            import('@flash/platform-web/onedrive'),
          ]);
        return createNativeOneDriveServices({
          bridge: await createMicrosoftSocialLoginBridge({
            clientId: microsoftClientId,
            ...(config.microsoftTenant ? { tenant: config.microsoftTenant } : {}),
            secureStore: secureStorage,
          }),
          storage: native.storage,
        });
      })
    : undefined;

  // In the background, so it never delays the first study screen.
  void clearPluginTokenCopiesAtLaunch({
    platform: mobilePlatform,
    secureStorage,
    storage: native.storage,
    ...(loadOneDrive ? { loadOneDrive } : {}),
  }).catch((err: unknown) => {
    console.warn('Could not clear sign-in plugin token copies at launch:', err);
  });

  return {
    ...composeNativePlatform(native, base),
    ...(loadOneDrive ? lazyOneDriveFields(loadOneDrive) : {}),
    // Phase 13 study reminders: OS local notifications (the PWA only shows an in-app badge).
    studyReminderDelivery: 'os-scheduled',
    getStudyReminderScheduler: async () => {
      const { createLocalNotificationReminderScheduler } =
        await import('../reminders/local-notification-reminders.ts');
      return createLocalNotificationReminderScheduler(createLocalNotificationsBridge());
    },
  };
}
