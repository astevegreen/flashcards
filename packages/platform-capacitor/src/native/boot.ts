import type { PlatformServices } from '@flash/platform';
import {
  composeNativePlatform,
  LazyHandwritingRecognizer,
  lazyOneDriveFields,
} from '@flash/platform-web/native-support';
import { Capacitor } from '@capacitor/core';
import { createCapacitorPlatform } from '../index.ts';
import {
  createFileBridge,
  createGoogleSignInPlugin,
  createICloudDocumentPlugin,
  createLocalNotificationsBridge,
  createMlKitInkPlugin,
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

/**
 * Boots `PlatformServices` for the Capacitor Android / iOS shell with real native plugins.
 * Called by `apps/web/src/main.tsx` only when `Capacitor.isNativePlatform()` is true.
 *
 * On iOS, iCloud Drive sync uses the app's own Swift plugin (`ICloudDocumentsPlugin.swift`),
 * registered by `MainViewController`.
 */
export async function bootCapacitorPlatform(
  config: CapacitorBootConfig,
): Promise<PlatformServices> {
  const platformName = Capacitor.getPlatform();
  const sqliteDriver = await openCapacitorSqliteDriver();

  const googleSignInPlugin = config.googleClientId
    ? await createGoogleSignInPlugin({
        webClientId: config.googleClientId,
        ...(config.googleIosClientId ? { iOSClientId: config.googleIosClientId } : {}),
      }).catch((err: unknown) => {
        console.warn('Google Sign-In plugin unavailable:', err);
        return undefined;
      })
    : undefined;

  const base = config.base;
  const native = createCapacitorPlatform({
    deviceId: `capacitor-${platformName}`,
    deviceLabel: platformName === 'ios' ? 'iPhone / iPad' : 'Android Device',
    sqliteDriver,
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
  const oneDrive = microsoftClientId
    ? lazyOneDriveFields(async () => {
        const [{ createMicrosoftSocialLoginBridge }, { createNativeOneDriveServices }] =
          await Promise.all([
            import('./microsoft-social-login.ts'),
            import('@flash/platform-web/onedrive'),
          ]);
        return createNativeOneDriveServices({
          bridge: await createMicrosoftSocialLoginBridge({
            clientId: microsoftClientId,
            ...(config.microsoftTenant ? { tenant: config.microsoftTenant } : {}),
          }),
          storage: native.storage,
        });
      })
    : {};

  return {
    ...composeNativePlatform(native, base),
    ...oneDrive,
    // Phase 13 study reminders: OS local notifications (the PWA only shows an in-app badge).
    studyReminderDelivery: 'os-scheduled',
    getStudyReminderScheduler: async () => {
      const { createLocalNotificationReminderScheduler } =
        await import('../reminders/local-notification-reminders.ts');
      return createLocalNotificationReminderScheduler(createLocalNotificationsBridge());
    },
  };
}
